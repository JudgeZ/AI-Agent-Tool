package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/go-playground/validator/v10"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

var stateTTL = getDurationEnv("OAUTH_STATE_TTL", 10*time.Minute)
var orchestratorTimeout = getDurationEnv("ORCHESTRATOR_CALLBACK_TIMEOUT", 10*time.Second)
var allowedRedirectOrigins = loadAllowedRedirectOrigins()
var requestValidator = validator.New(validator.WithRequiredStructEnabled())

const (
	auditEventAuthorize   = "auth.oauth.authorize"
	auditEventCallback    = "auth.oauth.callback"
	auditEventRedirectErr = "auth.oauth.redirect"
	auditTargetAuth       = "auth.oauth"
	auditCapabilityAuth   = "auth.public"

	auditOutcomeSuccess = "success"
	auditOutcomeDenied  = "denied"
	auditOutcomeFailure = "failure"

	defaultAuthIPLimit        = 30
	defaultAuthIdentityLimit  = 10
	defaultAuthIPWindow       = time.Minute
	defaultAuthIdentityWindow = time.Minute
)

type validationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

type authorizeRequestParams struct {
	RedirectURI string `validate:"required,uri,max=2048" json:"redirect_uri"`
}

type callbackRequestParams struct {
	Code  string `validate:"required,max=512" json:"code"`
	State string `validate:"required,max=512" json:"state"`
}

func emitAuthEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, eventName, outcome string, details map[string]any) {
	actor := hashedActorFromRequest(r, trusted)
	ctx = audit.WithActor(ctx, actor)
	sanitised := auditDetails(details)
	event := audit.Event{
		Name:       eventName,
		Outcome:    outcome,
		Target:     auditTargetAuth,
		Capability: auditCapabilityAuth,
		ActorID:    actor,
		Details:    sanitised,
	}

	switch outcome {
	case auditOutcomeSuccess:
		gatewayAuditLogger.Info(ctx, event)
	case auditOutcomeDenied:
		gatewayAuditLogger.Security(ctx, event)
	default:
		gatewayAuditLogger.Error(ctx, event)
	}
}

func auditAuthorizeEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, outcome string, details map[string]any) {
	emitAuthEvent(ctx, r, trusted, auditEventAuthorize, outcome, details)
}

func auditCallbackEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, outcome string, details map[string]any) {
	emitAuthEvent(ctx, r, trusted, auditEventCallback, outcome, details)
}

func auditRedirectEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, outcome string, details map[string]any) {
	emitAuthEvent(ctx, r, trusted, auditEventRedirectErr, outcome, details)
}

func redirectHost(redirectURI string) string {
	parsed, err := url.Parse(redirectURI)
	if err != nil {
		return ""
	}
	return parsed.Host
}

func redirectHash(redirectURI string) string {
	if redirectURI == "" {
		return ""
	}
	return gatewayAuditLogger.HashIdentity(redirectURI)
}

func mergeDetails(base map[string]any, extras map[string]any) map[string]any {
	result := make(map[string]any, len(base)+len(extras))
	for key, value := range base {
		result[key] = value
	}
	for key, value := range extras {
		result[key] = value
	}
	return result
}

type oidcDiscovery struct {
	authorizationEndpoint string
}

var oidcDiscoveryCache struct {
	metadata oidcDiscovery
	expires  time.Time
	mu       sync.RWMutex
}

type redirectOrigin struct {
	scheme string
	host   string
	port   string
}

type oauthProvider struct {
	Name         string
	AuthorizeURL string
	RedirectURI  string
	ClientID     string
	Scopes       []string
}

type stateData struct {
	Provider     string
	RedirectURI  string
	CodeVerifier string
	ExpiresAt    time.Time
	State        string
}

// AuthRouteConfig captures configuration for the OAuth routes.
type AuthRouteConfig struct {
	TrustedProxyCIDRs        []string
	AllowInsecureStateCookie bool
}

func getProviderConfig(provider string) (oauthProvider, error) {
	switch provider {
	case "openrouter", "google":
		redirectBase := strings.TrimRight(getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"), "/")
		openrouterClientID, err := resolveEnvValue("OPENROUTER_CLIENT_ID")
		if err != nil {
			return oauthProvider{}, fmt.Errorf("failed to load OPENROUTER_CLIENT_ID: %w", err)
		}
		googleClientID, err := resolveEnvValue("GOOGLE_OAUTH_CLIENT_ID")
		if err != nil {
			return oauthProvider{}, fmt.Errorf("failed to load GOOGLE_OAUTH_CLIENT_ID: %w", err)
		}
		configs := map[string]oauthProvider{
			"openrouter": {
				Name:         "openrouter",
				AuthorizeURL: "https://openrouter.ai/oauth/authorize",
				RedirectURI:  fmt.Sprintf("%s/auth/openrouter/callback", redirectBase),
				ClientID:     openrouterClientID,
				Scopes:       []string{"offline", "openid", "profile"},
			},
			"google": {
				Name:         "google",
				AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
				RedirectURI:  fmt.Sprintf("%s/auth/google/callback", redirectBase),
				ClientID:     googleClientID,
				Scopes:       []string{"openid", "profile", "email", "https://www.googleapis.com/auth/cloud-platform"},
			},
		}
		cfg, ok := configs[provider]
		if !ok {
			return oauthProvider{}, fmt.Errorf("unknown provider: %s", provider)
		}
		if cfg.ClientID == "" {
			return oauthProvider{}, fmt.Errorf("provider %s is not configured", provider)
		}
		return cfg, nil
	case "oidc":
		return getOidcProvider()
	default:
		return oauthProvider{}, fmt.Errorf("unknown provider: %s", provider)
	}
}

func authorizeHandler(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecureStateCookie bool) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/authorize")
	cfg, err := getProviderConfig(provider)
	if err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, map[string]any{
			"provider": provider,
			"error":    err.Error(),
		})
		writeErrorResponse(w, r, http.StatusNotFound, "not_found", err.Error(), nil)
		return
	}

	params := authorizeRequestParams{
		RedirectURI: strings.TrimSpace(r.URL.Query().Get("redirect_uri")),
	}
	if errs := validateRequestParams(params); len(errs) > 0 {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, map[string]any{
			"provider": provider,
			"reason":   errs[0].Message,
		})
		writeValidationError(w, r, errs)
		return
	}
	redirectURI := params.RedirectURI
	if redirectErr := validateClientRedirect(redirectURI); redirectErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, map[string]any{
			"provider":           provider,
			"reason":             redirectErr.Error(),
			"redirect_uri_hash":  redirectHash(redirectURI),
			"redirect_uri_host":  redirectHost(redirectURI),
			"validation_failure": true,
		})
		writeValidationError(w, r, []validationError{
			{Field: "redirect_uri", Message: redirectErr.Error()},
		})
		return
	}

	state, codeVerifier, codeChallenge, err := generateStateAndPKCE()
	if err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, map[string]any{
			"provider":          provider,
			"reason":            "state_generation_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to generate state", nil)
		return
	}

	data := stateData{
		Provider:     provider,
		RedirectURI:  redirectURI,
		CodeVerifier: codeVerifier,
		ExpiresAt:    time.Now().Add(stateTTL),
		State:        state,
	}

	if stateErr := setStateCookie(w, r, trustedProxies, allowInsecureStateCookie, data); stateErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, map[string]any{
			"provider":          provider,
			"reason":            "state_persistence_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to persist state", nil)
		return
	}

	authURL, err := buildAuthorizeURL(cfg, state, codeChallenge)
	if err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, map[string]any{
			"provider":          provider,
			"reason":            "authorize_url_build_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to build authorize url", nil)
		return
	}

	if err := validateAuthorizeRedirect(authURL, cfg.AuthorizeURL); err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, map[string]any{
			"provider":          provider,
			"reason":            "authorize_url_validation_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to build authorize url", nil)
		return
	}

	auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeSuccess, map[string]any{
		"provider":          provider,
		"redirect_uri_host": redirectHost(redirectURI),
	})

	sendRedirect(w, r, authURL)
}

func callbackHandler(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecureStateCookie bool) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/callback")
	baseDetails := map[string]any{"provider": provider}

	cfg, err := getProviderConfig(provider)
	if err != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"error": err.Error(),
		}))
		writeErrorResponse(w, r, http.StatusNotFound, "not_found", err.Error(), nil)
		return
	}

	if errParam := r.URL.Query().Get("error"); errParam != "" {
		redirectError(w, r, trustedProxies, allowInsecureStateCookie, errParam)
		return
	}

	params := callbackRequestParams{
		Code:  strings.TrimSpace(r.URL.Query().Get("code")),
		State: strings.TrimSpace(r.URL.Query().Get("state")),
	}
	if errs := validateRequestParams(params); len(errs) > 0 {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": errs[0].Message,
		}))
		writeValidationError(w, r, errs)
		return
	}

	data, err := readStateCookie(r, params.State)
	if err != nil || data.Provider != provider {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": "invalid_or_expired_state",
			"state":  params.State,
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}

	deleteStateCookie(w, r, trustedProxies, allowInsecureStateCookie, params.State)

	payload := map[string]string{
		"code":          params.Code,
		"code_verifier": data.CodeVerifier,
		"redirect_uri":  cfg.RedirectURI,
	}

	buf, err := json.Marshal(payload)
	if err != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"reason":            "payload_encoding_failed",
			"redirect_uri_hash": redirectHash(data.RedirectURI),
		}))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to encode payload", nil)
		return
	}
	orchestratorURL := strings.TrimRight(getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000"), "/")
	endpoint := fmt.Sprintf("%s/auth/%s/callback", orchestratorURL, url.PathEscape(provider))
	ctx, cancel := context.WithTimeout(r.Context(), orchestratorTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"reason":            "upstream_request_failed",
			"redirect_uri_hash": redirectHash(data.RedirectURI),
		}))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to create upstream request", nil)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client, clientErr := getOrchestratorClient()
	if clientErr != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"reason":            "upstream_client_not_configured",
			"redirect_uri_hash": redirectHash(data.RedirectURI),
		}))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "orchestrator client not configured", nil)
		return
	}

	resp, err := client.Do(req)
	if err != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"reason":            "upstream_unreachable",
			"redirect_uri_hash": redirectHash(data.RedirectURI),
		}))
		writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to contact orchestrator", nil)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		safeError, detailedError, errorCode := sanitizeOrchestratorError(body)
		details := mergeDetails(baseDetails, map[string]any{
			"reason":            "upstream_error",
			"status_code":       resp.StatusCode,
			"error":             detailedError,
			"redirect_uri_hash": redirectHash(data.RedirectURI),
		})
		if errorCode != "" {
			details["error_code"] = errorCode
		}
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, details)
		redirectWithStatus(w, r, data.RedirectURI, data.State, "error", safeError)
		return
	}

	normalizedCookies, hardenedDetails, droppedDetails := normalizeUpstreamCookies(resp.Cookies())
	if len(droppedDetails) > 0 {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeSuccess, mergeDetails(baseDetails, map[string]any{
			"action":  "upstream_cookie_rejected",
			"cookies": droppedDetails,
		}))
	}
	if len(hardenedDetails) > 0 {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeSuccess, mergeDetails(baseDetails, map[string]any{
			"action":  "upstream_cookie_hardened",
			"cookies": hardenedDetails,
		}))
	}
	for _, cookie := range normalizedCookies {
		http.SetCookie(w, cookie)
	}

	auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeSuccess, mergeDetails(baseDetails, map[string]any{
		"redirect_uri_host": redirectHost(data.RedirectURI),
	}))

	redirectWithStatus(w, r, data.RedirectURI, data.State, "success", "")
}

func redirectError(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecureStateCookie bool, errParam string) {
	state := r.URL.Query().Get("state")
	if state == "" {
		auditRedirectEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, map[string]any{
			"reason": errParam,
		})
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", errParam, nil)
		return
	}
	data, err := readStateCookie(r, state)
	if err != nil {
		auditRedirectEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, map[string]any{
			"reason": errParam,
			"state":  state,
		})
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", errParam, nil)
		return
	}
	deleteStateCookie(w, r, trustedProxies, allowInsecureStateCookie, state)
	auditRedirectEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, map[string]any{
		"reason":            errParam,
		"state":             state,
		"redirect_uri_hash": redirectHash(data.RedirectURI),
	})
	redirectWithStatus(w, r, data.RedirectURI, data.State, "error", errParam)
}

func redirectWithStatus(w http.ResponseWriter, r *http.Request, redirectURI, state, status, message string) {
	target, err := url.Parse(redirectURI)
	if err != nil {
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "invalid redirect_uri", nil)
		return
	}
	q := target.Query()
	if state != "" {
		q.Set("state", state)
	}
	q.Set("status", status)
	if status == "error" && message != "" {
		q.Set("error", message)
	}
	target.RawQuery = q.Encode()
	sendRedirect(w, r, target)
}

func validateRequestParams(payload interface{}) []validationError {
	if payload == nil {
		return []validationError{{Field: "", Message: "invalid request"}}
	}
	if err := requestValidator.Struct(payload); err != nil {
		var validationErrs validator.ValidationErrors
		if errors.As(err, &validationErrs) {
			return convertValidationErrors(payload, validationErrs)
		}
		return []validationError{{Field: "", Message: err.Error()}}
	}
	return nil
}

func convertValidationErrors(payload interface{}, errs validator.ValidationErrors) []validationError {
	var result []validationError
	payloadType := reflect.TypeOf(payload)
	if payloadType.Kind() == reflect.Ptr {
		payloadType = payloadType.Elem()
	}

	tagLookup := map[string]string{}
	if payloadType.Kind() == reflect.Struct {
		for i := 0; i < payloadType.NumField(); i++ {
			field := payloadType.Field(i)
			if field.PkgPath != "" {
				continue
			}
			if tag := field.Tag.Get("json"); tag != "" && tag != "-" {
				parts := strings.Split(tag, ",")
				if len(parts) > 0 && parts[0] != "" {
					tagLookup[field.Name] = parts[0]
				}
			}
		}
	}

	for _, fieldErr := range errs {
		fieldName := fieldErr.StructField()
		if jsonName, ok := tagLookup[fieldName]; ok {
			fieldName = jsonName
		}
		message := formatValidationMessage(fieldName, fieldErr)
		result = append(result, validationError{
			Field:   fieldName,
			Message: message,
		})
	}
	return result
}

func formatValidationMessage(field string, err validator.FieldError) string {
	switch err.Tag() {
	case "required":
		return fmt.Sprintf("%s is required", field)
	case "uri":
		return fmt.Sprintf("%s must be a valid URL", field)
	case "max":
		return fmt.Sprintf("%s must not exceed %s characters", field, err.Param())
	default:
		return fmt.Sprintf("%s failed %s validation", field, err.Tag())
	}
}

var orchestratorErrorMessages = map[string]string{
	"access_denied":           "authentication failed",
	"invalid_client":          "authentication failed",
	"invalid_grant":           "authentication failed",
	"invalid_request":         "authentication failed",
	"invalid_scope":           "authentication failed",
	"temporarily_unavailable": "authentication temporarily unavailable",
	"server_error":            "authentication temporarily unavailable",
}

type orchestratorErrorEnvelope struct {
	Error json.RawMessage `json:"error"`
	Code  string          `json:"code"`
}

type orchestratorErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type orchestratorUnifiedError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func sanitizeOrchestratorError(body []byte) (safe string, detailed string, code string) {
	safe = "authentication failed"
	detailed = strings.TrimSpace(string(body))
	if detailed == "" {
		detailed = "authentication failed"
	}
	defaultDetailed := detailed

	var unified orchestratorUnifiedError
	if err := json.Unmarshal(body, &unified); err == nil {
		if unified.Message != "" {
			detailed = unified.Message
		}
		if unified.Code != "" {
			code = unified.Code
		}
	}

	var envelope orchestratorErrorEnvelope
	if err := json.Unmarshal(body, &envelope); err == nil {
		if len(envelope.Error) > 0 {
			var structured orchestratorErrorBody
			if err := json.Unmarshal(envelope.Error, &structured); err == nil {
				if structured.Message != "" && detailed == defaultDetailed {
					detailed = structured.Message
				}
				if structured.Code != "" && code == "" {
					code = structured.Code
				}
			} else {
				var legacyMessage string
				if err := json.Unmarshal(envelope.Error, &legacyMessage); err == nil && legacyMessage != "" && detailed == defaultDetailed {
					detailed = legacyMessage
				}
			}
		}
		if code == "" && envelope.Code != "" {
			code = envelope.Code
		}
	}

	if code != "" {
		if msg, ok := orchestratorErrorMessages[code]; ok {
			safe = msg
		}
	} else {
		var legacy struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal(body, &legacy); err == nil {
			if legacy.Error != "" {
				detailed = legacy.Error
			}
			if legacy.Code != "" {
				code = legacy.Code
				if msg, ok := orchestratorErrorMessages[legacy.Code]; ok {
					safe = msg
				}
			}
		}
	}

	return safe, detailed, code
}

func generateStateAndPKCE() (string, string, string, error) {
	state, err := randomString(32)
	if err != nil {
		return "", "", "", err
	}
	verifier, err := randomString(64)
	if err != nil {
		return "", "", "", err
	}
	challenge := pkceChallenge(verifier)
	return state, verifier, challenge, nil
}

func randomString(length int) (string, error) {
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func buildAuthorizeURL(cfg oauthProvider, state, codeChallenge string) (*url.URL, error) {
	u, err := url.Parse(cfg.AuthorizeURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", cfg.RedirectURI)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	if len(cfg.Scopes) > 0 {
		q.Set("scope", strings.Join(cfg.Scopes, " "))
	}
	u.RawQuery = q.Encode()
	return u, nil
}

func validateClientRedirect(redirectURI string) error {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return errors.New("invalid redirect_uri")
	}

	if u.Scheme == "http" {
		host := u.Hostname()
		if host == "127.0.0.1" || host == "localhost" || host == "::1" {
			return nil
		}
	}

	if u.Scheme == "" || u.Host == "" {
		return errors.New("invalid redirect_uri")
	}

	if originAllowed(u) {
		return nil
	}

	return errors.New("redirect_uri must match an allowed origin")
}

func originAllowed(u *url.URL) bool {
	for _, allowed := range allowedRedirectOrigins {
		if allowed.matches(u) {
			return true
		}
	}
	return false
}

func (o redirectOrigin) matches(u *url.URL) bool {
	if !strings.EqualFold(o.scheme, u.Scheme) {
		return false
	}
	if !strings.EqualFold(o.host, u.Hostname()) {
		return false
	}
	return o.port == normalizePort(u)
}

func normalizePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

func loadAllowedRedirectOrigins() []redirectOrigin {
	var origins []redirectOrigin

	seen := make(map[string]struct{})

	allowedList := strings.Split(os.Getenv("OAUTH_ALLOWED_REDIRECT_ORIGINS"), ",")
	for _, entry := range allowedList {
		origin, ok := parseRedirectOrigin(strings.TrimSpace(entry))
		if ok {
			key := originKey(origin)
			if _, exists := seen[key]; !exists {
				origins = append(origins, origin)
				seen[key] = struct{}{}
			}
		}
	}

	if len(origins) == 0 {
		if origin, ok := parseRedirectOrigin(strings.TrimSpace(getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"))); ok {
			key := originKey(origin)
			if _, exists := seen[key]; !exists {
				origins = append(origins, origin)
				seen[key] = struct{}{}
			}
		}
	}

	return origins
}

func parseRedirectOrigin(raw string) (redirectOrigin, bool) {
	if raw == "" {
		return redirectOrigin{}, false
	}

	u, err := url.Parse(raw)
	if err != nil {
		return redirectOrigin{}, false
	}

	host := u.Hostname()
	if host == "" || u.Scheme == "" {
		return redirectOrigin{}, false
	}

	origin := redirectOrigin{
		scheme: strings.ToLower(u.Scheme),
		host:   strings.ToLower(host),
		port:   normalizePort(u),
	}

	if origin.port == "" {
		return redirectOrigin{}, false
	}

	return origin, true
}

func originKey(o redirectOrigin) string {
	return fmt.Sprintf("%s://%s:%s", o.scheme, o.host, o.port)
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func resolveEnvValue(key string) (string, error) {
	fileKey := key + "_FILE"
	if path := strings.TrimSpace(os.Getenv(fileKey)); path != "" {
		data, err := readSecretFile(path)
		if err != nil {
			return "", fmt.Errorf("failed to read %s: %w", fileKey, err)
		}
		value := strings.TrimSpace(string(data))
		if value != "" {
			return value, nil
		}
		return "", nil
	}
	value := strings.TrimSpace(os.Getenv(key))
	if value != "" {
		return value, nil
	}
	return "", nil
}

func readSecretFile(path string) ([]byte, error) {
	rootDir := strings.TrimSpace(os.Getenv("GATEWAY_SECRET_FILE_ROOT"))
	return readFileFromAllowedRoot(path, rootDir)
}

func setStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecure bool, data stateData) error {
	secureRequest := isRequestSecure(r, trustedProxies)
	if !secureRequest && !allowInsecure {
		return errors.New("refusing to issue state cookie over insecure request")
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     stateCookieName(data.State),
		Value:    base64.RawURLEncoding.EncodeToString(encoded),
		Path:     "/auth/",
		Expires:  data.ExpiresAt,
		MaxAge:   int(stateTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}

	if allowInsecure && !secureRequest {
		cookie.Secure = false
	}

	http.SetCookie(w, cookie)
	return nil
}

func readStateCookie(r *http.Request, state string) (stateData, error) {
	cookie, err := r.Cookie(stateCookieName(state))
	if err != nil {
		return stateData{}, err
	}

	decoded, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		return stateData{}, err
	}

	var data stateData
	if err := json.Unmarshal(decoded, &data); err != nil {
		return stateData{}, err
	}

	if data.State != state {
		return stateData{}, errors.New("state mismatch")
	}

	if time.Now().After(data.ExpiresAt) {
		return stateData{}, errors.New("state expired")
	}

	return data, nil
}

func deleteStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecure bool, state string) {
	secureRequest := isRequestSecure(r, trustedProxies)
	if !secureRequest && !allowInsecure {
		return
	}

	cookie := &http.Cookie{
		Name:     stateCookieName(state),
		Value:    "",
		Path:     "/auth/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}

	if allowInsecure && !secureRequest {
		cookie.Secure = false
	}

	http.SetCookie(w, cookie)
}

func normalizeUpstreamCookies(cookies []*http.Cookie) ([]*http.Cookie, []map[string]any, []map[string]any) {
	if len(cookies) == 0 {
		return []*http.Cookie{}, []map[string]any{}, []map[string]any{}
	}
	normalized := make([]*http.Cookie, 0, len(cookies))
	hardened := make([]map[string]any, 0)
	dropped := make([]map[string]any, 0)

	for _, cookie := range cookies {
		if cookie == nil {
			continue
		}
		if strings.TrimSpace(cookie.Name) == "" {
			dropped = append(dropped, map[string]any{
				"reasons": []string{"missing_name"},
			})
			continue
		}

		clone := *cookie
		enforcements := make([]string, 0, 3)

		if clone.SameSite == http.SameSiteNoneMode {
			dropped = append(dropped, map[string]any{
				"name_hash": gatewayAuditLogger.HashIdentity(cookie.Name),
				"reasons":   []string{"samesite_none_not_allowed"},
			})
			continue
		}

		if !clone.Secure {
			clone.Secure = true
			enforcements = append(enforcements, "secure_enforced")
		}
		if !clone.HttpOnly {
			clone.HttpOnly = true
			enforcements = append(enforcements, "httponly_enforced")
		}
		if clone.SameSite != http.SameSiteStrictMode {
			clone.SameSite = http.SameSiteStrictMode
			enforcements = append(enforcements, "samesite_strict_enforced")
		}

		normalized = append(normalized, &clone)
		if len(enforcements) > 0 {
			hardened = append(hardened, map[string]any{
				"name_hash":    gatewayAuditLogger.HashIdentity(cookie.Name),
				"enforcements": enforcements,
			})
		}
	}

	return normalized, hardened, dropped
}

func validateAuthorizeRedirect(built *url.URL, configuredAuthorizeURL string) error {
	reference, err := url.Parse(configuredAuthorizeURL)
	if err != nil {
		return err
	}

	if !strings.EqualFold(built.Scheme, reference.Scheme) {
		return fmt.Errorf("authorize url scheme mismatch: %s", built.Scheme)
	}
	if !strings.EqualFold(built.Hostname(), reference.Hostname()) {
		return fmt.Errorf("authorize url host mismatch: %s", built.Hostname())
	}

	refPort := reference.Port()
	builtPort := built.Port()
	if refPort == "" {
		refPort = defaultPortForScheme(reference.Scheme)
	}
	if builtPort == "" {
		builtPort = defaultPortForScheme(built.Scheme)
	}

	if refPort != builtPort {
		return fmt.Errorf("authorize url port mismatch: %s", builtPort)
	}

	return nil
}

func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(scheme) {
	case "https":
		return "443"
	case "http":
		return "80"
	default:
		return ""
	}
}

func sendRedirect(w http.ResponseWriter, r *http.Request, target *url.URL) {
	if target == nil {
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to resolve redirect", nil)
		return
	}
	w.Header().Set("Location", target.String())
	w.WriteHeader(http.StatusFound)
}

func stateCookieName(state string) string {
	return fmt.Sprintf("oauth_state_%s", state)
}

func isRequestSecure(r *http.Request, trustedProxies []*net.IPNet) bool {
	if r.TLS != nil {
		return true
	}
	proto, ok := forwardedProto(r)
	if !ok {
		return false
	}
	remoteIP := requestRemoteIP(r)
	if !isTrustedProxy(remoteIP, trustedProxies) {
		return false
	}
	return strings.EqualFold(proto, "https")
}

func requestRemoteIP(r *http.Request) net.IP {
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	if host == "" {
		return nil
	}
	return net.ParseIP(host)
}

func forwardedProto(r *http.Request) (string, bool) {
	headers := []string{"X-Forwarded-Proto", "X-Forwarded-Protocol", "X-Url-Scheme"}
	for _, header := range headers {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			return value, true
		}
	}
	if ssl := strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")); ssl != "" {
		if strings.EqualFold(ssl, "on") || ssl == "1" || strings.EqualFold(ssl, "enabled") {
			return "https", true
		}
		return "http", true
	}
	for _, forwarded := range r.Header.Values("Forwarded") {
		directives := strings.Split(forwarded, ";")
		for _, directive := range directives {
			kv := strings.SplitN(strings.TrimSpace(directive), "=", 2)
			if len(kv) != 2 {
				continue
			}
			if strings.EqualFold(kv[0], "proto") {
				value := strings.Trim(strings.TrimSpace(kv[1]), "\"")
				if value != "" {
					return value, true
				}
			}
		}
	}
	return "", false
}

func RegisterAuthRoutes(mux *http.ServeMux, cfg AuthRouteConfig) {
	trustedProxies, err := parseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		panic(fmt.Sprintf("invalid trusted proxy configuration: %v", err))
	}

	limiter := newRateLimiter()
	policy := newAuthRateLimitPolicy()

	authorize := withAuthRateLimit(func(w http.ResponseWriter, r *http.Request) {
		authorizeHandler(w, r, trustedProxies, cfg.AllowInsecureStateCookie)
	}, limiter, policy.loginBuckets, trustedProxies, extractAuthorizeIdentity)

	callback := withAuthRateLimit(func(w http.ResponseWriter, r *http.Request) {
		callbackHandler(w, r, trustedProxies, cfg.AllowInsecureStateCookie)
	}, limiter, policy.tokenBuckets, trustedProxies, extractCallbackIdentity)

	mux.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/authorize"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, r, http.MethodGet)
				return
			}
			authorize(w, r)
		case strings.HasSuffix(r.URL.Path, "/callback"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, r, http.MethodGet)
				return
			}
			callback(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func methodNotAllowed(w http.ResponseWriter, r *http.Request, allowed string) {
	w.Header().Set("Allow", allowed)
	writeErrorResponse(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed", nil)
}

func respondTooManyRequests(w http.ResponseWriter, r *http.Request, retryAfter time.Duration) {
	if updated, _ := audit.EnsureRequestID(r, w); updated != nil {
		r = updated
	}
	if retryAfter <= 0 {
		retryAfter = time.Second
	}
	seconds := int((retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeErrorResponse(w, r, http.StatusTooManyRequests, "too_many_requests", "too many requests", nil)
}

func writeValidationError(w http.ResponseWriter, r *http.Request, errs []validationError) {
	details := any(errs)
	if len(errs) == 0 {
		details = nil
	}
	writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid request", details)
}

type httpErrorResponse struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	TraceID   string `json:"traceId,omitempty"`
}

func writeErrorResponse(w http.ResponseWriter, r *http.Request, status int, code, message string, details any) {
	payload := httpErrorResponse{
		Code:    code,
		Message: message,
		Details: details,
	}

	if requestID := strings.TrimSpace(r.Header.Get("X-Request-Id")); requestID != "" {
		payload.RequestID = requestID
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.ErrorContext(r.Context(), "gateway.write_error_response_failed", slog.String("error", err.Error()))
	}
}

func getDurationEnv(key string, fallback time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		dur, err := time.ParseDuration(value)
		if err == nil {
			return dur
		}
	}
	return fallback
}

func parseScopeList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		raw = "openid"
	}
	items := strings.FieldsFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r) || r == ','
	})
	set := make(map[string]struct{}, len(items)+1)
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed != "" {
			set[trimmed] = struct{}{}
		}
	}
	set["openid"] = struct{}{}
	result := make([]string, 0, len(set))
	for scope := range set {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result
}

type authRateLimitPolicy struct {
	loginBuckets []rateLimitBucket
	tokenBuckets []rateLimitBucket
}

func newAuthRateLimitPolicy() authRateLimitPolicy {
	ipWindow := resolveDuration([]string{"GATEWAY_AUTH_IP_RATE_LIMIT_WINDOW", "GATEWAY_AUTH_RATE_LIMIT_WINDOW"}, defaultAuthIPWindow)
	ipLimit := resolveLimit([]string{"GATEWAY_AUTH_IP_RATE_LIMIT_MAX", "GATEWAY_AUTH_RATE_LIMIT_MAX"}, defaultAuthIPLimit)
	identityWindow := resolveDuration([]string{"GATEWAY_AUTH_ID_RATE_LIMIT_WINDOW"}, defaultAuthIdentityWindow)
	identityLimit := resolveLimit([]string{"GATEWAY_AUTH_ID_RATE_LIMIT_MAX"}, defaultAuthIdentityLimit)

	return authRateLimitPolicy{
		loginBuckets: []rateLimitBucket{
			{Endpoint: "auth_login", IdentityType: "ip", Window: ipWindow, Limit: ipLimit},
			{Endpoint: "auth_login", IdentityType: "client", Window: identityWindow, Limit: identityLimit},
		},
		tokenBuckets: []rateLimitBucket{
			{Endpoint: "auth_token", IdentityType: "ip", Window: ipWindow, Limit: ipLimit},
			{Endpoint: "auth_token", IdentityType: "client", Window: identityWindow, Limit: identityLimit},
		},
	}
}

type rateLimitBucket struct {
	Endpoint     string
	IdentityType string
	Window       time.Duration
	Limit        int
}

type rateLimiter struct {
	mu          sync.Mutex
	windows     map[string]rateLimitWindow
	now         func() time.Time
	lastCleanup time.Time
}

type rateLimitWindow struct {
	expires time.Time
	count   int
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{
		windows: make(map[string]rateLimitWindow),
		now:     time.Now,
	}
}

func (r *rateLimiter) Allow(ctx context.Context, bucket rateLimitBucket, identity string) (bool, time.Duration, error) {
	if r == nil {
		return true, 0, nil
	}
	if bucket.Limit <= 0 || bucket.Window <= 0 {
		return true, 0, nil
	}

	key := fmt.Sprintf("%s|%s|%s", bucket.Endpoint, bucket.IdentityType, identity)
	now := r.now()

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.windows[key]
	if state.expires.IsZero() || now.After(state.expires) {
		state = rateLimitWindow{expires: now.Add(bucket.Window), count: 0}
	}

	if state.count >= bucket.Limit {
		retryAfter := state.expires.Sub(now)
		if retryAfter < 0 {
			retryAfter = 0
		}
		r.windows[key] = state
		return false, retryAfter, nil
	}

	state.count++
	r.windows[key] = state
	r.maybeCleanup(now)
	return true, 0, nil
}

const rateLimiterCleanupInterval = time.Minute

func (r *rateLimiter) maybeCleanup(now time.Time) {
	if r == nil {
		return
	}
	if !r.lastCleanup.IsZero() && now.Sub(r.lastCleanup) < rateLimiterCleanupInterval {
		return
	}
	for key, window := range r.windows {
		if now.After(window.expires) {
			delete(r.windows, key)
		}
	}
	r.lastCleanup = now
}

func resolveDuration(keys []string, fallback time.Duration) time.Duration {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if dur, err := time.ParseDuration(value); err == nil && dur > 0 {
				return dur
			}
		}
	}
	return fallback
}

func resolveLimit(keys []string, fallback int) int {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if limit, err := strconv.Atoi(value); err == nil && limit > 0 {
				return limit
			}
		}
	}
	if fallback <= 0 {
		return 1
	}
	return fallback
}

type identityExtractor func(*http.Request) (string, bool)

func withAuthRateLimit(
	handler http.HandlerFunc,
	limiter *rateLimiter,
	buckets []rateLimitBucket,
	trustedProxies []*net.IPNet,
	extractor identityExtractor,
) http.HandlerFunc {
	if limiter == nil {
		return handler
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, trustedProxies)
		if ip == "" {
			ip = "unknown"
		}

		var identity string
		identityLoaded := false

		for _, bucket := range buckets {
			var key string
			switch bucket.IdentityType {
			case "ip":
				key = ip
			default:
				if extractor == nil {
					continue
				}
				if !identityLoaded {
					identity, identityLoaded = extractor(r)
				}
				if !identityLoaded || identity == "" {
					continue
				}
				key = identity
			}

			allowed, retryAfter, err := limiter.Allow(r.Context(), bucket, key)
			if err != nil {
				slog.WarnContext(r.Context(), "gateway.ratelimit.allow_error",
					slog.String("endpoint", bucket.Endpoint),
					slog.String("identity_type", bucket.IdentityType),
					slog.String("error", err.Error()),
				)
				continue
			}
			if !allowed {
				respondTooManyRequests(w, r, retryAfter)
				return
			}
		}

		handler(w, r)
	}
}

func extractAuthorizeIdentity(r *http.Request) (string, bool) {
	redirectURI := strings.TrimSpace(r.URL.Query().Get("redirect_uri"))
	if redirectURI == "" {
		return "", false
	}
	parsed, err := url.Parse(redirectURI)
	if err != nil {
		return redirectURI, true
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return redirectURI, true
	}
	if port := strings.TrimSpace(parsed.Port()); port != "" {
		host = fmt.Sprintf("%s:%s", host, port)
	}
	return strings.ToLower(host), true
}

func extractCallbackIdentity(r *http.Request) (string, bool) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		return "", false
	}
	data, err := readStateCookie(r, state)
	if err != nil {
		return "", false
	}
	if data.RedirectURI == "" {
		return "", false
	}
	parsed, err := url.Parse(data.RedirectURI)
	if err != nil {
		return data.RedirectURI, true
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return data.RedirectURI, true
	}
	if port := strings.TrimSpace(parsed.Port()); port != "" {
		host = fmt.Sprintf("%s:%s", host, port)
	}
	return strings.ToLower(host), true
}

func loadOidcMetadata(issuer string) (oidcDiscovery, error) {
	trimmed := strings.TrimRight(issuer, "/")
	now := time.Now()
	cache := &oidcDiscoveryCache

	cache.mu.RLock()
	if cache.metadata.authorizationEndpoint != "" && now.Before(cache.expires) {
		metadata := cache.metadata
		cache.mu.RUnlock()
		return metadata, nil
	}
	cache.mu.RUnlock()

	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.metadata.authorizationEndpoint != "" && now.Before(cache.expires) {
		return cache.metadata, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	discoveryURL := fmt.Sprintf("%s/.well-known/openid-configuration", trimmed)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return oidcDiscovery{}, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return oidcDiscovery{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return oidcDiscovery{}, fmt.Errorf("oidc discovery returned %d", resp.StatusCode)
	}

	var payload struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return oidcDiscovery{}, err
	}
	if payload.AuthorizationEndpoint == "" {
		return oidcDiscovery{}, errors.New("oidc discovery missing authorization_endpoint")
	}

	metadata := oidcDiscovery{authorizationEndpoint: payload.AuthorizationEndpoint}
	cache.metadata = metadata
	cache.expires = now.Add(15 * time.Minute)
	return metadata, nil
}

func getOidcProvider() (oauthProvider, error) {
	issuer := strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL"))
	if issuer == "" {
		return oauthProvider{}, fmt.Errorf("oidc issuer not configured")
	}
	clientID, err := resolveEnvValue("OIDC_CLIENT_ID")
	if err != nil {
		return oauthProvider{}, fmt.Errorf("failed to load OIDC_CLIENT_ID: %w", err)
	}
	if clientID == "" {
		return oauthProvider{}, fmt.Errorf("oidc client id not configured")
	}

	metadata, err := loadOidcMetadata(issuer)
	if err != nil {
		return oauthProvider{}, err
	}

	redirectBase := strings.TrimRight(getEnv("OIDC_REDIRECT_BASE", getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080")), "/")
	if redirectBase == "" {
		redirectBase = "http://127.0.0.1:8080"
	}
	rawScopes := os.Getenv("OIDC_SCOPES")
	if strings.TrimSpace(rawScopes) == "" {
		rawScopes = "openid profile email"
	}
	scopes := parseScopeList(rawScopes)

	return oauthProvider{
		Name:         "oidc",
		AuthorizeURL: metadata.authorizationEndpoint,
		RedirectURI:  fmt.Sprintf("%s/auth/oidc/callback", redirectBase),
		ClientID:     clientID,
		Scopes:       scopes,
	}, nil
}
