package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

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

func TestAuthorizeHandlerGeneratesPKCEChallenge(t *testing.T) {
	t.Setenv("OPENROUTER_CLIENT_ID", "client-id")
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	req := httptest.NewRequest(http.MethodGet, "/auth/openrouter/authorize?redirect_uri=https://app.example.com/complete", nil)
	rec := httptest.NewRecorder()

	authorizeHandler(rec, req)

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
			rec := httptest.NewRecorder()

			authorizeHandler(rec, req)

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
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for expired state, got %d", rec.Code)
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
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when orchestrator contact fails, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "failed to contact orchestrator") {
		t.Fatalf("expected gateway error response, got %q", rec.Body.String())
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
			body := io.NopCloser(strings.NewReader(`{"error":"upstream failure"}`))
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
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req)

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
	if got := q.Get("error"); got != "upstream failure" {
		t.Fatalf("expected error message from orchestrator, got %s", got)
	}
	if got := q.Get("state"); got != data.State {
		t.Fatalf("expected state to round-trip, got %s", got)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}
