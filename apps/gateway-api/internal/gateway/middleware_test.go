package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		"Content-Security-Policy":   "default-src 'self'",
		"Permissions-Policy":        "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
		"Referrer-Policy":           "no-referrer",
		"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
		"X-XSS-Protection":          "0",
	}

	for header, value := range expected {
		if got := rr.Header().Get(header); got != value {
			t.Fatalf("unexpected header %s: got %q want %q", header, got, value)
		}
	}
}
