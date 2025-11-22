package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
	"github.com/go-playground/validator/v10"
)

var requestValidator = validator.New(validator.WithRequiredStructEnabled())
var tenantIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
var clientAppPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
var sessionBindingPattern = regexp.MustCompile(fmt.Sprintf(`^[A-Za-z0-9._-]{1,%d}$`, maxSessionBindingLength))
var allowedRedirectOrigins = loadAllowedRedirectOrigins()

func emitAuthEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, eventName, outcome string, details map[string]any) {
	actor := hashedActorFromRequest(r, trusted)
	ctx = audit.WithActor(ctx, actor)
	sanitised := auditDetails(details)
	if actor != "" {
		if sanitised == nil {
			sanitised = map[string]any{}
		}
		sanitised["actor_id"] = actor
	}
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

func normalizeTenantID(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", nil
	}
	if !tenantIDPattern.MatchString(trimmed) {
		return "", fmt.Errorf("tenant_id contains invalid characters")
	}
	return trimmed, nil
}

func hashTenantID(value string) string {
	if value == "" {
		return ""
	}
	return gatewayAuditLogger.HashIdentity("tenant", value)
}

func normalizeTenantKey(value string) string {
	if value == "" {
		return ""
	}
	return strings.ToLower(value)
}

func withTenantHash(details map[string]any, tenantHash string) map[string]any {
	if tenantHash == "" {
		return details
	}
	if details == nil {
		details = map[string]any{}
	}
	details["tenant_id_hash"] = tenantHash
	return details
}

func normalizeClientApp(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		trimmed = defaultClientApp
	}
	if !clientAppPattern.MatchString(trimmed) {
		return "", fmt.Errorf("client_app may only include letters, numbers, '.', '_' or '-'")
	}
	return strings.ToLower(trimmed), nil
}

func normalizeSessionBinding(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("session_binding may not be blank or whitespace")
	}
	if trimmed != value {
		return "", fmt.Errorf("session_binding may not include leading or trailing whitespace")
	}
	if !sessionBindingPattern.MatchString(value) {
		return "", fmt.Errorf("session_binding must be 1-%d characters and may only include letters, numbers, '.', '_' or '-'", maxSessionBindingLength)
	}
	return value, nil
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

func validateClientRedirect(redirectURI string) error {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return errors.New("invalid redirect_uri")
	}
	return validateClientRedirectURL(u)
}

func validateClientRedirectURL(u *url.URL) error {
	if u == nil {
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
		if origin, ok := parseRedirectOrigin(strings.TrimSpace(GetEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"))); ok {
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
