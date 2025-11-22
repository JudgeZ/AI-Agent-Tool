package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/JudgeZ/AI-Agent-Tool/apps/gateway-api/internal/audit"
)

func RegisterAuthRoutes(mux *http.ServeMux, cfg AuthRouteConfig) {
	trustedProxies, err := ParseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		// panic: startup-only
		panic(fmt.Sprintf("invalid trusted proxy configuration: %v", err))
	}

	// newRateLimiter is defined in global_rate_limit.go
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

	rawTenant := strings.TrimSpace(r.URL.Query().Get("tenant_id"))
	tenantHash := ""
	params := authorizeRequestParams{
		RedirectURI: strings.TrimSpace(r.URL.Query().Get("redirect_uri")),
		TenantID:    rawTenant,
		ClientApp:   strings.TrimSpace(r.URL.Query().Get("client_app")),
		BindingID:   r.URL.Query().Get("session_binding"),
	}
	if errs := validateRequestParams(params); len(errs) > 0 {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider": provider,
			"reason":   errs[0].Message,
		}, tenantHash))
		writeValidationError(w, r, errs)
		return
	}
	tenantID, tenantErr := normalizeTenantID(params.TenantID)
	if tenantErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            tenantValidationErrorMessage,
			"redirect_uri_hash": redirectHash(params.RedirectURI),
		}, tenantHash))
		writeValidationError(w, r, []validationError{{
			Field:   "tenant_id",
			Message: tenantValidationErrorMessage,
		}})
		return
	}
	params.TenantID = tenantID
	tenantHash = hashTenantID(tenantID)

	clientApp, appErr := normalizeClientApp(params.ClientApp)
	if appErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            appErr.Error(),
			"redirect_uri_hash": redirectHash(params.RedirectURI),
		}, tenantHash))
		writeValidationError(w, r, []validationError{{
			Field:   "client_app",
			Message: appErr.Error(),
		}})
		return
	}

	bindingID, bindingErr := normalizeSessionBinding(params.BindingID)
	if bindingErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            bindingErr.Error(),
			"redirect_uri_hash": redirectHash(params.RedirectURI),
		}, tenantHash))
		writeValidationError(w, r, []validationError{{
			Field:   "session_binding",
			Message: bindingErr.Error(),
		}})
		return
	}

	redirectURI := params.RedirectURI
	redirectURL, parseErr := url.Parse(redirectURI)
	if parseErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":           provider,
			"reason":             "invalid redirect_uri",
			"redirect_uri_hash":  redirectHash(redirectURI),
			"redirect_uri_host":  redirectHost(redirectURI),
			"validation_failure": true,
		}, tenantHash))
		writeValidationError(w, r, []validationError{{
			Field:   "redirect_uri",
			Message: "invalid redirect_uri",
		}})
		return
	}
	if redirectErr := validateClientRedirectURL(redirectURL); redirectErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":           provider,
			"reason":             redirectErr.Error(),
			"redirect_uri_hash":  redirectHash(redirectURI),
			"redirect_uri_host":  redirectHost(redirectURI),
			"validation_failure": true,
		}, tenantHash))
		writeValidationError(w, r, []validationError{
			{Field: "redirect_uri", Message: redirectErr.Error()},
		})
		return
	}

	registration, registrationFound, registrationsConfigured, regErr := getOidcClientRegistration(tenantID, clientApp)
	if regErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "client_registration_error",
			"redirect_uri_hash": redirectHash(redirectURI),
		}, tenantHash))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to load client configuration", nil)
		return
	}
	selectedClientID := cfg.ClientID
	if registrationFound {
		if !registration.allowsRedirect(redirectURL) {
			auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
				"provider":          provider,
				"reason":            "redirect_not_registered",
				"redirect_uri_hash": redirectHash(redirectURI),
				"client_app":        clientApp,
			}, tenantHash))
			writeValidationError(w, r, []validationError{{
				Field:   "redirect_uri",
				Message: "redirect_uri not registered for client",
			}})
			return
		}
		if registration.SessionBindingRequired && bindingID == "" {
			auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
				"provider":          provider,
				"reason":            "session_binding_required",
				"redirect_uri_hash": redirectHash(redirectURI),
				"client_app":        clientApp,
			}, tenantHash))
			writeValidationError(w, r, []validationError{{
				Field:   "session_binding",
				Message: "session_binding is required for this client",
			}})
			return
		}
		selectedClientID = registration.ClientID
	} else if registrationsConfigured {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "client_not_registered",
			"redirect_uri_hash": redirectHash(redirectURI),
			"client_app":        clientApp,
		}, tenantHash))
		writeValidationError(w, r, []validationError{{
			Field:   "client_app",
			Message: "client_app is not registered",
		}})
		return
	}
	cfg.ClientID = selectedClientID

	state, codeVerifier, codeChallenge, err := generateStateAndPKCEFunc()
	if err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "state_generation_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		}, tenantHash))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to generate state", nil)
		return
	}

	data := stateData{
		Provider:     provider,
		RedirectURI:  redirectURI,
		CodeVerifier: codeVerifier,
		ExpiresAt:    time.Now().Add(stateTTL),
		State:        state,
		TenantID:     tenantID,
		ClientApp:    clientApp,
		BindingID:    bindingID,
		ClientID:     selectedClientID,
	}

	if stateErr := setStateCookie(w, r, trustedProxies, allowInsecureStateCookie, data); stateErr != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "state_persistence_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
			"error":             stateErr.Error(),
		}, tenantHash))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to persist state", nil)
		return
	}

	authURL, err := buildAuthorizeURL(cfg, state, codeChallenge)
	if err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "authorize_url_build_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		}, tenantHash))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to build authorize url", nil)
		return
	}

	if err := validateAuthorizeRedirect(authURL, cfg.AuthorizeURL); err != nil {
		auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, withTenantHash(map[string]any{
			"provider":          provider,
			"reason":            "authorize_url_validation_failed",
			"redirect_uri_hash": redirectHash(redirectURI),
		}, tenantHash))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to build authorize url", nil)
		return
	}

	auditAuthorizeEvent(r.Context(), r, trustedProxies, auditOutcomeSuccess, withTenantHash(map[string]any{
		"provider":          provider,
		"redirect_uri_host": redirectHost(redirectURI),
	}, tenantHash))

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
	tenantID, tenantErr := normalizeTenantID(data.TenantID)
	if tenantErr != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": "invalid_state_tenant",
			"state":  params.State,
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	data.TenantID = tenantID
	tenantHash := hashTenantID(data.TenantID)
	if tenantHash != "" {
		baseDetails = mergeDetails(baseDetails, map[string]any{"tenant_id_hash": tenantHash})
	}

	clientApp, appErr := normalizeClientApp(data.ClientApp)
	if appErr != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": "invalid_state_client_app",
			"state":  params.State,
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	data.ClientApp = clientApp
	if clientApp != "" {
		baseDetails = mergeDetails(baseDetails, map[string]any{"client_app": clientApp})
	}

	bindingID, bindingErr := normalizeSessionBinding(data.BindingID)
	if bindingErr != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason":           "invalid_state_binding",
			"state":            params.State,
			"validation_error": bindingErr.Error(),
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	data.BindingID = bindingID
	stateClientID := strings.TrimSpace(data.ClientID)
	if len(stateClientID) > maxClientIDLength {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": "invalid_state_client_id",
			"state":  params.State,
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	data.ClientID = stateClientID

	registration, registrationFound, registrationsConfigured, regErr := getOidcClientRegistration(data.TenantID, clientApp)
	if regErr != nil {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeFailure, mergeDetails(baseDetails, map[string]any{
			"reason": "client_registration_error",
		}))
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to load client configuration", nil)
		return
	}
	expectedClientID := cfg.ClientID
	if registrationFound {
		expectedClientID = registration.ClientID
	} else if registrationsConfigured {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason": "client_not_registered",
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	if stateClientID != "" && stateClientID != expectedClientID {
		auditCallbackEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, mergeDetails(baseDetails, map[string]any{
			"reason":                  "state_client_id_mismatch",
			"state":                   params.State,
			"state_client_id_present": true,
		}))
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "invalid or expired state", nil)
		return
	}
	effectiveClientID := expectedClientID
	payload := map[string]string{
		"code":          params.Code,
		"code_verifier": data.CodeVerifier,
		"redirect_uri":  cfg.RedirectURI,
		"client_id":     effectiveClientID,
	}
	if data.TenantID != "" {
		payload["tenant_id"] = data.TenantID
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
	orchestratorURL := strings.TrimRight(GetEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000"), "/")
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
		redirectWithStatus(w, r, data.RedirectURI, data.State, "error", safeError, data.BindingID)
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

	redirectWithStatus(w, r, data.RedirectURI, data.State, "success", "", data.BindingID)
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
	tenantHash := hashTenantID(data.TenantID)
	details := map[string]any{
		"reason":            errParam,
		"state":             state,
		"redirect_uri_hash": redirectHash(data.RedirectURI),
	}
	if tenantHash != "" {
		details["tenant_id_hash"] = tenantHash
	}
	auditRedirectEvent(r.Context(), r, trustedProxies, auditOutcomeDenied, details)
	redirectWithStatus(w, r, data.RedirectURI, data.State, "error", errParam, data.BindingID)
}

func redirectWithStatus(w http.ResponseWriter, r *http.Request, redirectURI, state, status, message, binding string) {
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
	if binding != "" {
		q.Set("session_binding", binding)
	}
	target.RawQuery = q.Encode()
	sendRedirect(w, r, target)
}

func sendRedirect(w http.ResponseWriter, r *http.Request, target *url.URL) {
	if target == nil {
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to resolve redirect", nil)
		return
	}
	w.Header().Set("Location", target.String())
	w.WriteHeader(http.StatusFound)
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

type authRateLimitPolicy struct {
	loginBuckets []rateLimitBucket
	tokenBuckets []rateLimitBucket
}

func newAuthRateLimitPolicy() authRateLimitPolicy {
	ipWindow := ResolveDuration([]string{"GATEWAY_AUTH_IP_RATE_LIMIT_WINDOW", "GATEWAY_AUTH_RATE_LIMIT_WINDOW"}, defaultAuthIPWindow)
	ipLimit := ResolveLimit([]string{"GATEWAY_AUTH_IP_RATE_LIMIT_MAX", "GATEWAY_AUTH_RATE_LIMIT_MAX"}, defaultAuthIPLimit)
	identityWindow := ResolveDuration([]string{"GATEWAY_AUTH_ID_RATE_LIMIT_WINDOW"}, defaultAuthIdentityWindow)
	identityLimit := ResolveLimit([]string{"GATEWAY_AUTH_ID_RATE_LIMIT_MAX"}, defaultAuthIdentityLimit)

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
		ip := ClientIP(r, trustedProxies)
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
