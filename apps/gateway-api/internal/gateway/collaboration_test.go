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

func TestCollaborationAuthMiddlewareAcceptsQueryIdentity(t *testing.T) {
	tenant := "tenant-1"
	var capturedSessionID, capturedTenantID, capturedProjectID string
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123", TenantID: &tenant}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, nil, rateLimitBucket{}, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedSessionID = r.Header.Get("X-Session-Id")
		capturedTenantID = r.Header.Get("X-Tenant-Id")
		capturedProjectID = r.Header.Get("X-Project-Id")
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt&projectId=project-1", nil)
	req.Header.Set("Cookie", "session=abc")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, rr.Code)
	}
	if capturedSessionID != "session-123" || capturedTenantID != tenant || capturedProjectID != "project-1" {
		t.Fatalf("expected headers to be populated from session/query, got session=%q tenant=%q project=%q", capturedSessionID, capturedTenantID, capturedProjectID)
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
		queryTenant          string
		queryProject         string
		querySession         string
		filePath             string
		wantErr              bool
		wantNormalizedTenant string
		wantProject          string
		wantSession          string
	}{
		{
			name:                 "valid headers and path",
			tenant:               "tenant-1",
			project:              "project-1",
			session:              "session-1",
			filePath:             "docs/readme.md",
			wantNormalizedTenant: "tenant-1",
			wantProject:          "project-1",
			wantSession:          "session-1",
		},
		{
			name:                 "trims whitespace",
			tenant:               " tenant-2 ",
			project:              " project-2 ",
			session:              " session-2 ",
			filePath:             " nested/file.txt ",
			wantNormalizedTenant: "tenant-2",
			wantProject:          "project-2",
			wantSession:          "session-2",
		},
		{
			name:                 "accepts query identity",
			queryTenant:          "tenant-3",
			queryProject:         "project-3",
			querySession:         "session-3",
			filePath:             "docs/file.txt",
			wantNormalizedTenant: "tenant-3",
			wantProject:          "project-3",
			wantSession:          "session-3",
		},
		{
			name:     "allows missing ids",
			filePath: "docs/file.txt",
		},
		{
			name:     "invalid tenant",
			tenant:   "tenant with space",
			project:  "project-4",
			session:  "session-4",
			filePath: "docs/file.txt",
			wantErr:  true,
		},
		{
			name:     "invalid project pattern",
			project:  "project/5",
			filePath: "docs/file.txt",
			wantErr:  true,
		},
		{
			name:     "invalid session pattern",
			session:  "session 6",
			filePath: "docs/file.txt",
			wantErr:  true,
		},
		{
			name:     "file path traversal",
			filePath: "../secrets.txt",
			wantErr:  true,
		},
		{
			name:     "absolute file path",
			filePath: "/etc/passwd",
			wantErr:  true,
		},
		{
			name:     "file path contains null byte",
			filePath: "valid\x00path",
			wantErr:  true,
		},
		{
			name:     "file path exceeds limit",
			filePath: longPath,
			wantErr:  true,
		},
		{
			name:                 "file path at limit",
			filePath:             strings.Repeat("b", collaborationFilePathLimit),
			wantNormalizedTenant: "",
			wantProject:          "",
			wantSession:          "",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws", nil)
			q := req.URL.Query()
			if tc.filePath != "" {
				q.Set("filePath", tc.filePath)
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
			if tc.queryTenant != "" {
				q.Set("tenantId", tc.queryTenant)
			}
			if tc.queryProject != "" {
				q.Set("projectId", tc.queryProject)
			}
			if tc.querySession != "" {
				q.Set("sessionId", tc.querySession)
			}
			req.URL.RawQuery = q.Encode()

			tenant, project, session, filePath, err := parseCollaborationIdentity(req)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error but got none")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tenant != tc.wantNormalizedTenant {
				t.Fatalf("expected tenant %q, got %q", tc.wantNormalizedTenant, tenant)
			}
			if project != tc.wantProject {
				t.Fatalf("expected project %q, got %q", tc.wantProject, project)
			}
			if session != tc.wantSession {
				t.Fatalf("expected session %q, got %q", tc.wantSession, session)
			}
			if filePath != strings.TrimSpace(tc.filePath) {
				t.Fatalf("expected filePath %q, got %q", strings.TrimSpace(tc.filePath), filePath)
			}
		})
	}
}
