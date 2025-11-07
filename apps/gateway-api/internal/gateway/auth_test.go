package gateway

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

	authorizeHandler(rec, req, nil)

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

	authorizeHandler(rec, req, nil)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid redirect_uri to return 400, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "redirect_uri") {
		t.Fatalf("expected error body to mention redirect_uri, got %q", rec.Body.String())
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

			authorizeHandler(rec, req, nil)

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

	callbackHandler(rec, req, nil)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for expired state, got %d", rec.Code)
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
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for state mismatch, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid or expired state") {
		t.Fatalf("unexpected error message: %q", rec.Body.String())
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

	callbackHandler(rec, req, nil)

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

	callbackHandler(rec, req, nil)

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
	req.AddCookie(&http.Cookie{
		Name:  stateCookieName(data.State),
		Value: base64.RawURLEncoding.EncodeToString(encoded),
		Path:  "/auth/",
	})
	rec := httptest.NewRecorder()

	callbackHandler(rec, req, nil)

	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("expected orchestrator to be called once, got %d", got)
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
	var hasSession, hasRefresh, stateCleared bool
	for _, c := range cookies {
		switch c.Name {
		case "session":
			hasSession = c.Value == "abc"
		case "refresh":
			hasRefresh = c.Value == "def"
		default:
			if strings.HasPrefix(c.Name, "oauth_state_") && c.MaxAge == -1 {
				stateCleared = true
			}
		}
	}
	if !hasSession || !hasRefresh {
		t.Fatalf("expected cookies from orchestrator to be forwarded, got %#v", cookies)
	}
	if !stateCleared {
		t.Fatalf("expected state cookie to be cleared, got %#v", cookies)
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

	if err := setStateCookie(rec, req, data); err != nil {
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
	deleteStateCookie(delRec, req, data.State)
	cleared := findCookie(delRec.Result().Cookies(), stateCookieName(data.State))
	if cleared == nil || cleared.MaxAge != -1 {
		t.Fatalf("expected deleteStateCookie to expire cookie, got %#v", cleared)
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
