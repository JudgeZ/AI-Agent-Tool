package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestCollaborationProxyPreservesQuery(t *testing.T) {
	target, err := url.Parse("http://orchestrator:4000")
	if err != nil {
		t.Fatalf("failed to parse target: %v", err)
	}

	proxy := newCollaborationProxy(target)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.local/collaboration/ws?filePath=example.txt", nil)
	proxy.Director(req)

	if req.URL.Path != "/collaboration/ws" {
		t.Fatalf("expected path to be preserved, got %s", req.URL.Path)
	}

	if got := req.URL.RawQuery; got != "filePath=example.txt" {
		t.Fatalf("expected query to be preserved, got %q", got)
	}
}

func TestCollaborationAuthMiddlewareValidatesSession(t *testing.T) {
	var called bool
	validator := func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		return collaborationSession{ID: "session-123"}, http.StatusOK, nil
	}

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

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

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

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

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

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

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

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

	handler := collaborationAuthMiddleware(validator, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

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
