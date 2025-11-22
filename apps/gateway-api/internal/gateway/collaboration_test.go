package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestCollaborationProxyPreservesQuery(t *testing.T) {
	target, err := url.Parse("http://orchestrator:4000")
	if err != nil {
		t.Fatalf("failed to parse target: %v", err)
	}

	proxy := newCollaborationProxy(target)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	out := req.Clone(req.Context())
	proxy.Rewrite(&httputil.ProxyRequest{In: req, Out: out})

	if out.URL.Path != "/collaboration/ws" {
		t.Fatalf("expected path to be preserved, got %s", out.URL.Path)
	}

	if got := out.URL.RawQuery; got != "filePath=example.txt" {
		t.Fatalf("expected query to be preserved, got %q", got)
	}
}

func TestCollaborationAuthMiddlewareValidatesSession(t *testing.T) {
	var called bool
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	req.Header.Set("Authorization", "Bearer abc")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, rr.Code)
	}
	if !called {
		t.Fatalf("expected downstream handler to be invoked")
	}
}

func TestCollaborationAuthMiddlewareRejectsInvalidSession(t *testing.T) {
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{}, http.StatusUnauthorized, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	req.Header.Set("Authorization", "Bearer abc")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, rr.Code)
	}
}

func TestCollaborationAuthMiddlewareRejectsTenantMismatch(t *testing.T) {
	mismatch := "other-tenant"
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123", TenantID: &mismatch}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	req.Header.Set("Authorization", "Bearer abc")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, rr.Code)
	}
}

func TestCollaborationAuthMiddlewareRejectsSessionMismatch(t *testing.T) {
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-expected"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "different-session")
	req.Header.Set("Authorization", "Bearer abc")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, rr.Code)
	}
}

func TestNewCollaborationSessionValidatorPropagatesHeaders(t *testing.T) {
	var capturedAuth, capturedCookie, capturedRequestID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		capturedCookie = r.Header.Get("Cookie")
		capturedRequestID = r.Header.Get("X-Request-Id")

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"session":{"id":"session-xyz","tenantId":"tenant-1"}}`))
	}))
	t.Cleanup(server.Close)

	validator := newCollaborationSessionValidator(server.URL)
	session, status, err := validator(context.Background(), "Bearer token", "session=abc", "req-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, status)
	}
	if session.ID != "session-xyz" {
		t.Fatalf("unexpected session id %q", session.ID)
	}
	if capturedAuth != "Bearer token" || capturedCookie != "session=abc" || capturedRequestID != "req-123" {
		t.Fatalf("headers not propagated correctly")
	}
}

func TestNewCollaborationSessionValidatorHandlesErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		// Simulate upstream error
	}))
	t.Cleanup(server.Close)

	validator := newCollaborationSessionValidator(server.URL)
	_, status, err := validator(context.Background(), "", "", "")
	if status != http.StatusBadGateway {
		t.Fatalf("expected status %d, got %d", http.StatusBadGateway, status)
	}
	if err == nil {
		t.Fatalf("expected error from empty response body")
	}
}

func TestCollaborationAuthMiddlewareRejectsMissingAuth(t *testing.T) {
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, rr.Code)
	}
}

func TestCollaborationAuthMiddlewareRejectsPathTraversal(t *testing.T) {
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=../etc/passwd", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	req.Header.Set("Authorization", "Bearer token")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, rr.Code)
	}
}

func TestCollaborationAuthMiddlewareRejectsInvalidCookie(t *testing.T) {
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	req.Header.Set("X-Project-Id", "project-1")
	req.Header.Set("X-Session-Id", "session-123")
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Cookie", "invalid;cookie")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, rr.Code)
	}
}

func TestCollaborationAuthMiddlewareRateLimitsFailedAuth(t *testing.T) {
	base := time.Now()
	limiter := newRateLimiter()
	limiter.now = func() time.Time { return base }

	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{}, http.StatusUnauthorized, nil
	}

	handler := collaborationAuthMiddleware(validator, limiter, rateLimitBucket{Endpoint: "collaboration.auth_failure", IdentityType: "ip", Window: time.Minute, Limit: 2}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
		req.Header.Set("X-Tenant-Id", "tenant-1")
		req.Header.Set("X-Project-Id", "project-1")
		req.Header.Set("X-Session-Id", "session-123")
		req.Header.Set("Authorization", "Bearer token")
		req.RemoteAddr = "192.0.2.50:1234"
		rr := httptest.NewRecorder()

		handler.ServeHTTP(rr, req)

		if i < 2 {
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("expected status %d on attempt %d, got %d", http.StatusUnauthorized, i+1, rr.Code)
			}
			continue
		}

		if rr.Code != http.StatusTooManyRequests {
			t.Fatalf("expected rate limit status %d on attempt %d, got %d", http.StatusTooManyRequests, i+1, rr.Code)
		}
	}
}

func TestCollaborationConnectionLimiterReleasesConnections(t *testing.T) {
	limiter := newConnectionLimiter(1)
	handler := collaborationConnectionLimiter(nil, limiter, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws", nil)
	req.RemoteAddr = "192.0.2.1:12345"
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}

	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if _, ok := limiter.counts["192.0.2.1"]; ok {
		t.Fatalf("expected connection count to be released")
	}
}

func TestCollaborationConnectionLimiterReleasesOnContextCancel(t *testing.T) {
	limiter := newConnectionLimiter(1)
	ctx, cancel := context.WithCancel(context.Background())

	blocked := make(chan struct{})
	handler := collaborationConnectionLimiter(nil, limiter, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(blocked)
		<-r.Context().Done()
	}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws", nil).WithContext(ctx)
	req.RemoteAddr = "198.51.100.7:12345"
	rr := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rr, req)
		close(done)
	}()

	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatalf("handler did not start in time")
	}

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("handler did not return after context cancel")
	}

	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if _, ok := limiter.counts["198.51.100.7"]; ok {
		t.Fatalf("expected connection count to be released after context cancel")
	}
}

func TestValidateCollaborationIdentity(t *testing.T) {
	t.Parallel()

	longPath := strings.Repeat("a", collaborationFilePathLimit+1)
	cases := []struct {
		name                 string
		tenant               string
		project              string
		session              string
		filePath             string
		wantOK               bool
		wantNormalizedTenant string
	}{
		{
			name:                 "valid headers and path",
			tenant:               "tenant-1",
			project:              "project-1",
			session:              "session-1",
			filePath:             "docs/readme.md",
			wantOK:               true,
			wantNormalizedTenant: "tenant-1",
		},
		{
			name:                 "trims whitespace",
			tenant:               " tenant-2 ",
			project:              " project-2 ",
			session:              " session-2 ",
			filePath:             " nested/file.txt ",
			wantOK:               true,
			wantNormalizedTenant: "tenant-2",
		},
		{
			name:     "missing fields",
			tenant:   "",
			project:  "project-3",
			session:  "session-3",
			filePath: "docs/file.txt",
			wantOK:   false,
		},
		{
			name:     "invalid tenant",
			tenant:   "tenant with space",
			project:  "project-4",
			session:  "session-4",
			filePath: "docs/file.txt",
			wantOK:   false,
		},
		{
			name:     "invalid project pattern",
			tenant:   "tenant-5",
			project:  "project/5",
			session:  "session-5",
			filePath: "docs/file.txt",
			wantOK:   false,
		},
		{
			name:     "invalid session pattern",
			tenant:   "tenant-6",
			project:  "project-6",
			session:  "session 6",
			filePath: "docs/file.txt",
			wantOK:   false,
		},
		{
			name:     "file path traversal",
			tenant:   "tenant-7",
			project:  "project-7",
			session:  "session-7",
			filePath: "../secrets.txt",
			wantOK:   false,
		},
		{
			name:     "absolute file path",
			tenant:   "tenant-8",
			project:  "project-8",
			session:  "session-8",
			filePath: "/etc/passwd",
			wantOK:   false,
		},
		{
			name:     "file path contains null byte",
			tenant:   "tenant-9",
			project:  "project-9",
			session:  "session-9",
			filePath: "valid\x00path",
			wantOK:   false,
		},
		{
			name:     "file path exceeds limit",
			tenant:   "tenant-10",
			project:  "project-10",
			session:  "session-10",
			filePath: longPath,
			wantOK:   false,
		},
		{
			name:                 "file path at limit",
			tenant:               "tenant-11",
			project:              "project-11",
			session:              "session-11",
			filePath:             strings.Repeat("b", collaborationFilePathLimit),
			wantOK:               true,
			wantNormalizedTenant: "tenant-11",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws", nil)
			if tc.filePath != "" {
				q := req.URL.Query()
				q.Set("filePath", tc.filePath)
				req.URL.RawQuery = q.Encode()
			}
			if tc.tenant != "" {
				req.Header.Set("X-Tenant-Id", tc.tenant)
			}
			if tc.project != "" {
				req.Header.Set("X-Project-Id", tc.project)
			}
			if tc.session != "" {
				req.Header.Set("X-Session-Id", tc.session)
			}

			tenant, project, session, filePath, ok := validateCollaborationIdentity(req)
			if ok != tc.wantOK {
				t.Fatalf("expected ok=%v, got %v", tc.wantOK, ok)
			}

			if !tc.wantOK {
				return
			}

			if tenant != tc.wantNormalizedTenant {
				t.Fatalf("expected tenant %q, got %q", tc.wantNormalizedTenant, tenant)
			}
			if project != strings.TrimSpace(tc.project) {
				t.Fatalf("expected project %q, got %q", strings.TrimSpace(tc.project), project)
			}
			if session != strings.TrimSpace(tc.session) {
				t.Fatalf("expected session %q, got %q", strings.TrimSpace(tc.session), session)
			}
			if filePath != strings.TrimSpace(tc.filePath) {
				t.Fatalf("expected filePath %q, got %q", strings.TrimSpace(tc.filePath), filePath)
			}
		})
	}
}
