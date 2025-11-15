package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

type httpErrorPayload struct {
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Details   json.RawMessage `json:"details,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	TraceID   string          `json:"traceId,omitempty"`
}

func decodeErrorResponse(t *testing.T, rec *httptest.ResponseRecorder) httpErrorPayload {
	t.Helper()
	var resp httpErrorPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode error response: %v (body=%q)", err, rec.Body.String())
	}
	return resp
}

func extractValidationDetails(t *testing.T, payload httpErrorPayload) []validationError {
	t.Helper()
	if len(payload.Details) == 0 {
		return nil
	}
	var details []validationError
	if err := json.Unmarshal(payload.Details, &details); err != nil {
		t.Fatalf("failed to decode validation details: %v", err)
	}
	return details
}

func TestResolveEnvValueReadsFile(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "")
	dir := t.TempDir()
	path := filepath.Join(dir, "client_id")
	if err := os.WriteFile(path, []byte("file-client-id"), 0o600); err != nil {
		t.Fatalf("failed to write temp file: %v", err)
	}
	t.Setenv("OPENROUTER_CLIENT_ID_FILE", path)

	value, err := resolveEnvValue("OPENROUTER_CLIENT_ID")
	if err != nil {
		t.Fatalf("expected no error reading secret file: %v", err)
	}
	if value != "file-client-id" {
		t.Fatalf("expected value from file, got %q", value)
	}
}

func TestResolveEnvValueReturnsErrorWhenFileUnreadable(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID_FILE", filepath.Join(t.TempDir(), "missing"))
	if _, err := resolveEnvValue("OPENROUTER_CLIENT_ID"); err == nil {
		t.Fatal("expected error when secret file cannot be read")
	}
}

func TestGetProviderConfigReadsClientIDFromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "client_id")
	if err := os.WriteFile(path, []byte("from-file"), 0o600); err != nil {
		t.Fatalf("failed to write client id file: %v", err)
	}
	t.Setenv("OPENROUTER_CLIENT_ID_FILE", path)
	t.Setenv("OAUTH_REDIRECT_BASE", "https://app.example.com")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	cfg, err := getProviderConfig("openrouter")
	if err != nil {
		t.Fatalf("expected provider config, got error: %v", err)
	}
	if cfg.ClientID != "from-file" {
		t.Fatalf("expected client id from file, got %q", cfg.ClientID)
	}
}

func TestValidateClientRedirect_AllowsConfiguredOrigins(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://other.example.com/base")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://app.example.com/callback"); err != nil {
		t.Fatalf("expected redirect to be allowed, got error: %v", err)
	}
}

func TestValidateClientRedirect_RejectsUnauthorizedOrigin(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://evil.example.com/callback"); err == nil {
		t.Fatal("expected redirect to be rejected")
	}
}

func TestValidateClientRedirect_UsesRedirectBaseWhenAllowlistEmpty(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://ui.example.com/app")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://ui.example.com/complete"); err != nil {
		t.Fatalf("expected redirect based on base URL to be allowed, got error: %v", err)
	}
}

func TestValidateClientRedirect_AllowsLoopbackHTTP(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://ui.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("http://127.0.0.1:3000/callback"); err != nil {
		t.Fatalf("expected loopback redirect to be allowed, got error: %v", err)
	}
	if err := validateClientRedirect("http://localhost:8080/callback"); err != nil {
		t.Fatalf("expected localhost redirect to be allowed, got error: %v", err)
	}
}

func TestAuthorizeHandlerRejectsOversizedRedirectURI(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://app.example.com")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	longPath := strings.Repeat("a", 2100)
	values := url.Values{}
	values.Set("redirect_uri", "https://app.example.com/"+longPath)
	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?"+values.Encode(), nil)
	rec := httptest.NewRecorder()

	authorizeHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	payload := decodeErrorResponse(t, rec)
	details := extractValidationDetails(t, payload)
	if len(details) == 0 {
		t.Fatalf("expected validation details, got none")
	}
	if details[0].Field != "redirect_uri" {
		t.Fatalf("expected field redirect_uri, got %s", details[0].Field)
	}
	if !strings.Contains(details[0].Message, "must not exceed 2048 characters") {
		t.Fatalf("unexpected validation message: %s", details[0].Message)
	}
}

func TestCallbackHandlerRejectsOversizedState(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://app.example.com")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	longState := strings.Repeat("a", 600)
	values := url.Values{}
	values.Set("code", "authcode")
	values.Set("state", longState)

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?"+values.Encode(), nil)
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	payload := decodeErrorResponse(t, rec)
	details := extractValidationDetails(t, payload)
	if len(details) == 0 {
		t.Fatalf("expected validation details, got none")
	}
	if details[0].Field != "state" {
		t.Fatalf("expected field state, got %s", details[0].Field)
	}
	if !strings.Contains(details[0].Message, "must not exceed 512 characters") {
		t.Fatalf("unexpected validation message: %s", details[0].Message)
	}
}

func TestAuthorizeHandlerGeneratesPKCEChallenge(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri=https://app.example.com/complete", nil)
	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()

	authorizeHandler(rec, req, nil, false)

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect status, got %d", res.StatusCode)
	}

	location := res.Header.Get("Location")
	if location == "" {
		t.Fatal("expected redirect location header")
	}
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("failed to parse redirect location: %v", err)
	}

	var stateCookie *http.Cookie
	for _, cookie := range res.Cookies() {
		if strings.HasPrefix(cookie.Name, "oauth_state_") {
			stateCookie = cookie
			break
		}
	}
	if stateCookie == nil {
		t.Fatal("expected state cookie to be set")
	}

	decoded, err := base64.RawURLEncoding.DecodeString(stateCookie.Value)
	if err != nil {
		t.Fatalf("failed to decode state cookie: %v", err)
	}
	var stored stateData
	if err := json.Unmarshal(decoded, &stored); err != nil {
		t.Fatalf("failed to unmarshal state data: %v", err)
	}

	if stored.RedirectURI != "https://app.example.com/complete" {
		t.Fatalf("expected redirect uri to be preserved, got %s", stored.RedirectURI)
	}
	if stored.State == "" {
		t.Fatal("expected state value to be generated")
	}
	if stored.CodeVerifier == "" {
		t.Fatal("expected PKCE code verifier to be generated")
	}

	q := parsed.Query()
	if got := q.Get("state"); got != stored.State {
		t.Fatalf("expected state %s in authorize URL, got %s", stored.State, got)
	}
	if got := q.Get("code_challenge"); got != pkceChallenge(stored.CodeVerifier) {
		t.Fatalf("expected PKCE challenge to match verifier, got %s", got)
	}
	if got := q.Get("redirect_uri"); got != "http://127.0.0.1:8080/auth/openrouter/callback" {
		t.Fatalf("unexpected redirect_uri in authorize URL: %s", got)
	}
}

func TestAuthorizeHandlerRejectsInvalidRedirect(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri=https://evil.example.com", nil)
	rec := httptest.NewRecorder()

	authorizeHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid redirect_uri to return 400, got %d", rec.Code)
	}
	resp := decodeErrorResponse(t, rec)
	if resp.Code != "invalid_request" {
		t.Fatalf("expected error=invalid_request, got %s", resp.Code)
	}
	details := extractValidationDetails(t, resp)
	if len(details) != 1 || details[0].Field != "redirect_uri" {
		t.Fatalf("unexpected validation details: %+v", details)
	}
	if !strings.Contains(details[0].Message, "redirect_uri") {
		t.Fatalf("expected validation message to reference redirect_uri, got %s", details[0].Message)
	}
}

func TestAuthorizeHandlerRejectsMissingRedirect(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize", nil)
	rec := httptest.NewRecorder()

	authorizeHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected missing redirect_uri to return 400, got %d", rec.Code)
	}
	resp := decodeErrorResponse(t, rec)
	details := extractValidationDetails(t, resp)
	if len(details) != 1 || details[0].Field != "redirect_uri" {
		t.Fatalf("unexpected validation response: %+v", details)
	}
	if !strings.Contains(details[0].Message, "required") {
		t.Fatalf("expected required message, got %s", details[0].Message)
	}
}

func TestAuthorizeHandlerAllowsExpectedRedirects(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	redirectURIs := []string{
		"https://app.example.com/complete",
		"http://127.0.0.1:3000/callback",
		"http://localhost:8080/callback",
	}

	for _, redirectURI := range redirectURIs {
		t.Run(redirectURI, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri="+url.QueryEscape(redirectURI), nil)
			req.TLS = &tls.ConnectionState{}
			rec := httptest.NewRecorder()

			authorizeHandler(rec, req, nil, false)

			if rec.Code != http.StatusFound {
				t.Fatalf("expected authorize handler to redirect for %s, got %d", redirectURI, rec.Code)
			}
		})
	}
}

func TestCallbackHandlerRejectsExpiredState(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(-1 * time.Minute),
		State:        "state-token",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=state-token", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for expired state, got %d", rec.Code)
	}
}

func TestCallbackHandlerRejectsMissingParameters(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=&state=", nil)
	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected missing parameters to return 400, got %d", rec.Code)
	}

	resp := decodeErrorResponse(t, rec)
	details := extractValidationDetails(t, resp)
	if len(details) != 2 {
		t.Fatalf("expected two validation errors, got %+v", details)
	}
	var fields = map[string]string{}
	for _, detail := range details {
		fields[detail.Field] = detail.Message
	}
	if msg, ok := fields["code"]; !ok || !strings.Contains(msg, "required") {
		t.Fatalf("expected code validation error, got %+v", details)
	}
	if msg, ok := fields["state"]; !ok || !strings.Contains(msg, "required") {
		t.Fatalf("expected state validation error, got %+v", details)
	}
}

func TestAuthRoutesRateLimiterBlocksExcessiveRequests(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	t.Setenv("GATEWAY_AUTH_IP_RATE_LIMIT_WINDOW", "1m")
	t.Setenv("GATEWAY_AUTH_IP_RATE_LIMIT_MAX", "2")
	t.Setenv("GATEWAY_AUTH_ID_RATE_LIMIT_WINDOW", "1m")
	t.Setenv("GATEWAY_AUTH_ID_RATE_LIMIT_MAX", "100")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	mux := http.NewServeMux()
	RegisterAuthRoutes(mux, AuthRouteConfig{})

	makeRequest := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri=http://127.0.0.1/callback", nil)
		req.TLS = &tls.ConnectionState{}
		req.RemoteAddr = "192.0.2.10:12345"
		mux.ServeHTTP(rec, req)
		return rec
	}

	for i := 0; i < 2; i++ {
		rec := makeRequest()
		if rec.Code != http.StatusFound {
			t.Fatalf("expected request %d to be allowed, got status %d", i+1, rec.Code)
		}
	}

	rec := makeRequest()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected rate limiter to block with 429, got %d", rec.Code)
	}
	if retryAfter := rec.Header().Get("Retry-After"); retryAfter == "" {
		t.Fatal("expected Retry-After header to be set")
	}
	resp := decodeErrorResponse(t, rec)
	if resp.Code != "too_many_requests" {
		t.Fatalf("expected error code too_many_requests, got %s", resp.Code)
	}
}

func TestAuthRoutesRateLimiterBlocksPerIdentity(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	t.Setenv("GATEWAY_AUTH_IP_RATE_LIMIT_WINDOW", "1m")
	t.Setenv("GATEWAY_AUTH_IP_RATE_LIMIT_MAX", "100")
	t.Setenv("GATEWAY_AUTH_ID_RATE_LIMIT_WINDOW", "1m")
	t.Setenv("GATEWAY_AUTH_ID_RATE_LIMIT_MAX", "2")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	mux := http.NewServeMux()
	RegisterAuthRoutes(mux, AuthRouteConfig{})

	makeRequest := func(ip string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri=https://app.example.com/callback", nil)
		req.TLS = &tls.ConnectionState{}
		req.RemoteAddr = ip
		mux.ServeHTTP(rec, req)
		return rec
	}

	if code := makeRequest("198.51.100.1:3333").Code; code != http.StatusFound {
		t.Fatalf("expected first request to pass, got %d", code)
	}
	if code := makeRequest("203.0.113.9:4444").Code; code != http.StatusFound {
		t.Fatalf("expected second request to pass, got %d", code)
	}

	rec := makeRequest("192.0.2.5:5555")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected identity limiter to block with 429, got %d", rec.Code)
	}
	if retryAfter := rec.Header().Get("Retry-After"); retryAfter == "" {
		t.Fatal("expected Retry-After header to be set")
	}
	resp := decodeErrorResponse(t, rec)
	if resp.Code != "too_many_requests" {
		t.Fatalf("expected error code too_many_requests, got %s", resp.Code)
	}
}

func TestRespondTooManyRequestsEnsuresRequestID(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/auth/test", nil)

	respondTooManyRequests(rec, req, time.Second)

	requestID := strings.TrimSpace(rec.Header().Get("X-Request-Id"))
	if requestID == "" {
		t.Fatal("expected respondTooManyRequests to set X-Request-Id header")
	}

	payload := decodeErrorResponse(t, rec)
	if payload.RequestID != requestID {
		t.Fatalf("expected response payload to include requestId %q, got %q", requestID, payload.RequestID)
	}
}

func TestCallbackHandlerRejectsStateMismatch(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(1 * time.Minute),
		State:        "original-state",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=different-state", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for state mismatch, got %d", rec.Code)
	}
	resp := decodeErrorResponse(t, rec)
	if resp.Code != "invalid_request" {
		t.Fatalf("expected invalid_request code, got %s", resp.Code)
	}
	if resp.Message != "invalid or expired state" {
		t.Fatalf("unexpected error message: %q", resp.Message)
	}
}

func TestCallbackHandlerHandlesOrchestratorContactFailure(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	SetOrchestratorClientFactory(func() (*http.Client, error) {
		return &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		})}, nil
	})
	t.Cleanup(ResetOrchestratorClient)

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(1 * time.Minute),
		State:        "state-token",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=state-token", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when orchestrator contact fails, got %d", rec.Code)
	}
	resp := decodeErrorResponse(t, rec)
	if resp.Code != "upstream_error" {
		t.Fatalf("expected upstream_error code, got %s", resp.Code)
	}
	if resp.Message != "failed to contact orchestrator" {
		t.Fatalf("unexpected error message: %q", resp.Message)
	}
}

func TestCallbackHandlerRedirectsOnOrchestratorError(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	originalTimeout := orchestratorTimeout
	orchestratorTimeout = 150 * time.Millisecond
	t.Cleanup(func() { orchestratorTimeout = originalTimeout })

	var observedDeadline time.Time
	var callCount int

	SetOrchestratorClientFactory(func() (*http.Client, error) {
		return &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			callCount++
			if deadline, ok := req.Context().Deadline(); ok {
				observedDeadline = deadline
			}
			body := io.NopCloser(strings.NewReader(`{"error":"upstream failure","code":"invalid_grant"}`))
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Body:       body,
				Header:     make(http.Header),
			}, nil
		})}, nil
	})
	t.Cleanup(ResetOrchestratorClient)

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(1 * time.Minute),
		State:        "state-token",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	start := time.Now()
	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=state-token", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if callCount != 1 {
		t.Fatalf("expected single orchestrator call, got %d", callCount)
	}
	if observedDeadline.IsZero() {
		t.Fatal("expected orchestrator request to set a deadline")
	}
	minDeadline := start.Add(orchestratorTimeout - 50*time.Millisecond)
	maxDeadline := start.Add(orchestratorTimeout + 50*time.Millisecond)
	if observedDeadline.Before(minDeadline) || observedDeadline.After(maxDeadline) {
		t.Fatalf("expected deadline within timeout window, got %v (want between %v and %v)", observedDeadline, minDeadline, maxDeadline)
	}

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect response, got %d", res.StatusCode)
	}

	location := res.Header.Get("Location")
	if location == "" {
		t.Fatal("expected redirect location header")
	}
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("failed to parse redirect location: %v", err)
	}
	q := parsed.Query()
	if got := q.Get("status"); got != "error" {
		t.Fatalf("expected status=error, got %s", got)
	}
	if got := q.Get("error"); got != "authentication failed" {
		t.Fatalf("expected sanitized error message, got %s", got)
	}
	if got := q.Get("state"); got != data.State {
		t.Fatalf("expected state to round-trip, got %s", got)
	}
}

func TestCallbackHandlerSuccessPropagatesCookies(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	var requestCount int32
	SetOrchestratorClientFactory(func() (*http.Client, error) {
		return &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&requestCount, 1)
			body := io.NopCloser(strings.NewReader(`{"status":"ok"}`))
			resp := &http.Response{
				StatusCode: http.StatusOK,
				Body:       body,
				Header:     make(http.Header),
			}
			resp.Header.Add("Set-Cookie", (&http.Cookie{Name: "session", Value: "abc"}).String())
			resp.Header.Add("Set-Cookie", (&http.Cookie{Name: "refresh", Value: "def"}).String())
			return resp, nil
		})}, nil
	})
	t.Cleanup(ResetOrchestratorClient)

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(1 * time.Minute),
		State:        "state-token",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=state-token", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("expected orchestrator to be called once, got %d", got)
	}

	if secure := isRequestSecure(req, nil); !secure {
		t.Fatalf("expected request to be secure")
	}

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect response, got %d", res.StatusCode)
	}

	location := res.Header.Get("Location")
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatalf("failed to parse redirect location: %v", err)
	}
	q := parsed.Query()
	if got := q.Get("status"); got != "success" {
		t.Fatalf("expected status=success, got %s", got)
	}
	if got := q.Get("state"); got != data.State {
		t.Fatalf("expected state to be preserved, got %s", got)
	}

	cookies := res.Cookies()
	if len(cookies) < 3 {
		t.Fatalf("expected state deletion cookie plus upstream cookies, got %d", len(cookies))
	}
	var sessionCookie, refreshCookie *http.Cookie
	stateCleared := false
	for _, c := range cookies {
		switch c.Name {
		case "session":
			sessionCookie = c
		case "refresh":
			refreshCookie = c
		default:
			if strings.HasPrefix(c.Name, "oauth_state_") && c.MaxAge == -1 {
				stateCleared = true
			}
		}
	}
	if sessionCookie == nil || refreshCookie == nil {
		t.Fatalf("expected session and refresh cookies to be set: %#v", cookies)
	}
	for _, cookie := range []*http.Cookie{sessionCookie, refreshCookie} {
		if cookie.Value == "" {
			t.Fatalf("expected cookie %s to retain value", cookie.Name)
		}
		if !cookie.Secure {
			t.Fatalf("expected cookie %s to be Secure", cookie.Name)
		}
		if !cookie.HttpOnly {
			t.Fatalf("expected cookie %s to be HttpOnly", cookie.Name)
		}
		if cookie.SameSite != http.SameSiteStrictMode {
			t.Fatalf("expected cookie %s to enforce SameSite=Strict, got %v", cookie.Name, cookie.SameSite)
		}
	}
	if !stateCleared {
		t.Fatalf("expected state cookie to be cleared, got %#v", cookies)
	}
}

func TestCallbackHandlerDropsInsecureUpstreamCookie(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	SetOrchestratorClientFactory(func() (*http.Client, error) {
		return &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			body := io.NopCloser(strings.NewReader(`{"status":"ok"}`))
			resp := &http.Response{
				StatusCode: http.StatusOK,
				Body:       body,
				Header:     make(http.Header),
			}
			resp.Header.Add("Set-Cookie", (&http.Cookie{Name: "session", Value: "abc", SameSite: http.SameSiteNoneMode}).String())
			return resp, nil
		})}, nil
	})
	t.Cleanup(ResetOrchestratorClient)

	var buf bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{})))
	gatewayAuditLogger = audit.Default()
	t.Cleanup(func() {
		slog.SetDefault(original)
		gatewayAuditLogger = audit.Default()
	})

	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "verifier",
		ExpiresAt:    time.Now().Add(1 * time.Minute),
		State:        "state-token",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("failed to encode state data: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/callback?code=abc&state=state-token", nil)
	req.TLS = &tls.ConnectionState{}
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil, false)

	res := rec.Result()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect response, got %d", res.StatusCode)
	}
	for _, cookie := range res.Cookies() {
		if cookie.Name == "session" {
			t.Fatalf("expected insecure upstream cookie to be dropped")
		}
	}

	logs := buf.String()
	scanner := bufio.NewScanner(strings.NewReader(logs))
	found := false
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if event, _ := entry["event"].(string); event != "auth.oauth.callback" {
			continue
		}
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		if details["action"] == "upstream_cookie_rejected" {
			found = true
			if outcome, _ := entry["outcome"].(string); outcome != "success" {
				t.Fatalf("expected audit outcome to be success for sanitized cookies, got %q", outcome)
			}
			if _, ok := details["cookies"]; !ok {
				t.Fatalf("expected dropped cookie details to be recorded: %q", line)
			}
			break
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("failed to scan audit logs: %v", err)
	}
	if !found {
		t.Fatalf("expected audit log to note cookie rejection, got %q", logs)
	}
}

func TestGenerateStateAndPKCE(t *testing.T) {
	state, verifier, challenge, err := generateStateAndPKCE()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if state == "" || verifier == "" || challenge == "" {
		t.Fatal("expected generated values to be non-empty")
	}
	if challenge != pkceChallenge(verifier) {
		t.Fatalf("expected challenge to be derived from verifier")
	}
	if len(state) < 32 {
		t.Fatalf("expected state to be sufficiently random, got length %d", len(state))
	}
}

func TestSetAndReadStateCookie(t *testing.T) {
	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "code-verifier",
		ExpiresAt:    time.Now().Add(2 * time.Minute),
		State:        "token",
	}
	req := httptest.NewRequest(http.MethodGet, "https://example.com/auth/openrouter/authorize", nil)
	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()

	if err := setStateCookie(rec, req, nil, false, data); err != nil {
		t.Fatalf("failed to set state cookie: %v", err)
	}
	res := rec.Result()
	cookie := findCookie(res.Cookies(), stateCookieName(data.State))
	if cookie == nil {
		t.Fatal("expected state cookie to be set")
	}
	if !cookie.Secure {
		t.Fatal("expected state cookie to be secure when request is TLS")
	}

	req.AddCookie(cookie)
	readBack, err := readStateCookie(req, data.State)
	if err != nil {
		t.Fatalf("expected cookie to be readable, got %v", err)
	}
	if readBack.Provider != data.Provider || readBack.RedirectURI != data.RedirectURI || readBack.CodeVerifier != data.CodeVerifier {
		t.Fatalf("expected stored data to round trip, got %#v", readBack)
	}
	if !readBack.ExpiresAt.Equal(data.ExpiresAt) {
		t.Fatalf("expected expiry to round trip, got %v want %v", readBack.ExpiresAt, data.ExpiresAt)
	}

	delRec := httptest.NewRecorder()
	deleteStateCookie(delRec, req, nil, false, data.State)
	cleared := findCookie(delRec.Result().Cookies(), stateCookieName(data.State))
	if cleared == nil || cleared.MaxAge != -1 {
		t.Fatalf("expected deleteStateCookie to expire cookie, got %#v", cleared)
	}
}

func TestSetStateCookieRejectsInsecureRequestsByDefault(t *testing.T) {
	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "code-verifier",
		ExpiresAt:    time.Now().Add(2 * time.Minute),
		State:        "token",
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.com/auth/openrouter/authorize", nil)
	rec := httptest.NewRecorder()

	if err := setStateCookie(rec, req, nil, false, data); err == nil {
		t.Fatal("expected insecure request to be rejected")
	}
}

func TestSetStateCookieAllowsInsecureWhenConfigured(t *testing.T) {
	data := stateData{
		Provider:     "openrouter",
		RedirectURI:  "https://app.example.com/complete",
		CodeVerifier: "code-verifier",
		ExpiresAt:    time.Now().Add(2 * time.Minute),
		State:        "token",
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.com/auth/openrouter/authorize", nil)
	rec := httptest.NewRecorder()

	if err := setStateCookie(rec, req, nil, true, data); err != nil {
		t.Fatalf("expected insecure request to be allowed when configured: %v", err)
	}
	cookie := findCookie(rec.Result().Cookies(), stateCookieName(data.State))
	if cookie == nil {
		t.Fatal("expected cookie to be set")
	}
	if cookie.Secure {
		t.Fatal("expected secure flag to be disabled for insecure request")
	}
}

func TestIsRequestSecureRespectsTrustedProxies(t *testing.T) {
	trusted, err := parseTrustedProxyCIDRs([]string{"10.0.0.0/8"})
	if err != nil {
		t.Fatalf("failed to parse trusted proxies: %v", err)
	}

	tests := []struct {
		name        string
		remoteAddr  string
		protoHeader string
		trusted     []*net.IPNet
		want        bool
	}{
		{
			name:        "direct client spoofing https",
			remoteAddr:  "198.51.100.23:1234",
			protoHeader: "https",
			trusted:     nil,
			want:        false,
		},
		{
			name:        "trusted proxy forwarding https",
			remoteAddr:  "10.0.0.5:443",
			protoHeader: "https",
			trusted:     trusted,
			want:        true,
		},
		{
			name:        "trusted proxy forwarding http",
			remoteAddr:  "10.0.0.6:80",
			protoHeader: "http",
			trusted:     trusted,
			want:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.com/auth/openrouter/authorize", nil)
			req.RemoteAddr = tt.remoteAddr
			if tt.protoHeader != "" {
				req.Header.Set("X-Forwarded-Proto", tt.protoHeader)
			}
			if got := isRequestSecure(req, tt.trusted); got != tt.want {
				t.Fatalf("isRequestSecure() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestReadStateCookieErrors(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "https://example.com/auth/openrouter/authorize", nil)
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName("token"),
		Value: base64.RawURLEncoding.EncodeToString([]byte(`{"state":"other"}`)),
		Path:  "/auth/",
	})

	if _, err := readStateCookie(req, "token"); err == nil {
		t.Fatal("expected state mismatch to error")
	}
}

func TestParseScopeList(t *testing.T) {
	scopes := parseScopeList("profile, email custom")
	expected := []string{"custom", "email", "openid", "profile"}
	if len(scopes) != len(expected) {
		t.Fatalf("unexpected scope length: got %v want %v", scopes, expected)
	}
	for i, scope := range expected {
		if scopes[i] != scope {
			t.Fatalf("unexpected scope order at %d: got %s want %s", i, scopes[i], scope)
		}
	}
}

func TestLoadOidcMetadataCachingAndTimeout(t *testing.T) {
	resetOidcCache()

	var callCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&callCount, 1)
		_, _ = io.WriteString(w, `{"authorization_endpoint":"https://issuer.example.com/auth"}`)
	}))
	t.Cleanup(server.Close)

	originalClient := http.DefaultClient
	http.DefaultClient = server.Client()
	t.Cleanup(func() { http.DefaultClient = originalClient })

	issuer := server.URL
	meta1, err := loadOidcMetadata(issuer)
	if err != nil {
		t.Fatalf("unexpected error loading metadata: %v", err)
	}
	meta2, err := loadOidcMetadata(issuer)
	if err != nil {
		t.Fatalf("unexpected error loading cached metadata: %v", err)
	}
	if meta1.authorizationEndpoint != meta2.authorizationEndpoint {
		t.Fatalf("expected cached metadata to match, got %v vs %v", meta1, meta2)
	}
	if atomic.LoadInt32(&callCount) != 1 {
		t.Fatalf("expected discovery endpoint to be called once, got %d", callCount)
	}

	originalRoundTripper := http.DefaultClient.Transport
	deadlineObserved := make(chan time.Time, 1)
	http.DefaultClient.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		if d, ok := req.Context().Deadline(); ok {
			deadlineObserved <- d
		} else {
			deadlineObserved <- time.Time{}
		}
		return nil, context.DeadlineExceeded
	})
	t.Cleanup(func() { http.DefaultClient.Transport = originalRoundTripper })

	resetOidcCache()
	start := time.Now()
	_, err = loadOidcMetadata(issuer)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded error, got %v", err)
	}
	select {
	case deadline := <-deadlineObserved:
		if deadline.IsZero() {
			t.Fatal("expected request deadline to be set")
		}
		if deadline.Before(start.Add(4*time.Second)) || deadline.After(start.Add(6*time.Second)) {
			t.Fatalf("expected deadline approximately 5s from start, got %v", deadline)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for deadline observation")
	}
}

func resetOidcCache() {
	oidcDiscoveryCache.mu.Lock()
	oidcDiscoveryCache.metadata = oidcDiscovery{}
	oidcDiscoveryCache.expires = time.Time{}
	oidcDiscoveryCache.mu.Unlock()
}

func findCookie(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}
