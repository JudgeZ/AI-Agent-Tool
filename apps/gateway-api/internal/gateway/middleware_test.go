package gateway

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

func TestDefaultMaxRequestBodyBytes(t *testing.T) {
	if got := DefaultMaxRequestBodyBytes(); got != defaultMaxBodyBytes {
		t.Fatalf("unexpected default body limit: got %d want %d", got, defaultMaxBodyBytes)
	}
}

func TestRequestBodyLimitMiddlewareRejectsLargePayload(t *testing.T) {
	handler := RequestBodyLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err == nil {
			t.Fatalf("expected read error for oversized payload")
		}
	}), 8)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Body = io.NopCloser(strings.NewReader("0123456789"))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
}

type stubBody struct {
	io.Reader
}

func (stubBody) Close() error { return nil }

func TestRequestBodyLimitMiddlewareDisabledForNonPositiveLimit(t *testing.T) {
	originalBody := &stubBody{Reader: strings.NewReader("payload")}
	handler := RequestBodyLimitMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != originalBody {
			t.Fatalf("expected original body when limit disabled")
		}
		w.WriteHeader(http.StatusNoContent)
	}), 0)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Body = originalBody
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("unexpected status code: got %d want %d", rr.Code, http.StatusNoContent)
	}
}

func TestSecurityHeadersMiddleware(t *testing.T) {
	handler := SecurityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	expected := map[string]string{
		"Content-Security-Policy":      "default-src 'self'",
		"Permissions-Policy":           "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
		"Referrer-Policy":              "no-referrer",
		"Strict-Transport-Security":    "max-age=63072000; includeSubDomains",
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"X-XSS-Protection":             "0",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Opener-Policy":   "same-origin",
	}

	for header, value := range expected {
		if got := rr.Header().Get(header); got != value {
			t.Fatalf("unexpected header %s: got %q want %q", header, got, value)
		}
	}
}

func TestGlobalRateLimiterEnforcesIPLimit(t *testing.T) {
	t.Setenv("GATEWAY_HTTP_RATE_LIMIT_MAX", "1")
	t.Setenv("GATEWAY_HTTP_RATE_LIMIT_WINDOW", "1m")

	limiter := NewGlobalRateLimiter(nil)
	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.10:1234"

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, req)
	if first.Code != http.StatusOK {
		t.Fatalf("expected first request to succeed, got %d", first.Code)
	}

	secondReq := httptest.NewRequest(http.MethodGet, "/", nil)
	secondReq.RemoteAddr = "203.0.113.10:4321"

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, secondReq)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second request to be rate limited, got %d", second.Code)
	}
	if retry := second.Header().Get("Retry-After"); retry == "" {
		t.Fatal("expected Retry-After header to be set")
	}
}

func TestGlobalRateLimiterEmitsAuditEventForAgentLimit(t *testing.T) {
	t.Setenv("GATEWAY_HTTP_IP_RATE_LIMIT_MAX", "100")
	t.Setenv("GATEWAY_HTTP_AGENT_RATE_LIMIT_MAX", "1")

	var buf bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{})))
	t.Cleanup(func() {
		slog.SetDefault(original)
		gatewayAuditLogger = audit.Default()
	})
	gatewayAuditLogger = audit.Default()

	limiter := NewGlobalRateLimiter(nil)
	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.10:1234"
	req.Header.Set("X-Agent", "code-writer")

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, req)
	if first.Code != http.StatusOK {
		t.Fatalf("expected first request to succeed, got %d", first.Code)
	}

	secondReq := httptest.NewRequest(http.MethodGet, "/", nil)
	secondReq.RemoteAddr = "203.0.113.11:9000"
	secondReq.Header.Set("X-Agent", "code-writer")
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, secondReq)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second agent request to be rate limited, got %d", second.Code)
	}

	logs := buf.String()
	if !strings.Contains(logs, "gateway.http.rate_limit") {
		t.Fatalf("expected audit log to include rate limit event, got %q", logs)
	}
	if !strings.Contains(logs, "\"outcome\":\"denied\"") {
		t.Fatalf("expected denied outcome in audit log, got %q", logs)
	}
}

func TestGlobalRateLimiterAppliesAnonymousAgentBucket(t *testing.T) {
	t.Setenv("GATEWAY_HTTP_IP_RATE_LIMIT_MAX", "100")
	t.Setenv("GATEWAY_HTTP_AGENT_RATE_LIMIT_MAX", "1")

	limiter := NewGlobalRateLimiter(nil)
	handler := limiter.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.12:4000"

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, req)
	if first.Code != http.StatusOK {
		t.Fatalf("expected first anonymous agent request to succeed, got %d", first.Code)
	}

	secondReq := httptest.NewRequest(http.MethodGet, "/", nil)
	secondReq.RemoteAddr = "203.0.113.13:5000"

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, secondReq)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("expected anonymous agent requests to share rate limit, got %d", second.Code)
	}
	if retry := second.Header().Get("Retry-After"); retry == "" {
		t.Fatal("expected Retry-After header to be set for anonymous agent limit")
	}
}
