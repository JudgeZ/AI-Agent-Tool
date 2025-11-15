package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"log/slog"
)

type recordingHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

type customStringer struct{}

func (customStringer) String() string { return "stringer" }

type customType struct{}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool {
	return true
}

func (h *recordingHandler) Handle(ctx context.Context, record slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, record.Clone())
	return nil
}

func (h *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return h
}

func (h *recordingHandler) WithGroup(string) slog.Handler {
	return h
}

func TestDefaultUsesEnvironmentSalt(t *testing.T) {
	t.Setenv("GATEWAY_AUDIT_SALT", "custom")

	logger := Default()
	if logger.salt != "custom" {
		t.Fatalf("expected salt to come from environment, got %q", logger.salt)
	}
}

func TestDefaultFallsBackToConstantSalt(t *testing.T) {
	t.Setenv("GATEWAY_AUDIT_SALT", "")

	logger := Default()
	if logger.salt != defaultSalt {
		t.Fatalf("expected fallback salt %q, got %q", defaultSalt, logger.salt)
	}
}

func TestWithActor(t *testing.T) {
	base := context.Background()
	ctx := WithActor(base, "user-123")
	if got := ctx.Value(actorContextKey); got != "user-123" {
		t.Fatalf("expected actor stored in context, got %v", got)
	}

	if unchanged := WithActor(base, ""); unchanged != base {
		t.Fatalf("expected empty actor to return original context")
	}
}

func TestMiddlewareManagesRequestID(t *testing.T) {
	tests := []struct {
		name        string
		headerValue string
		expectReuse bool
	}{
		{name: "generates when missing", headerValue: "", expectReuse: false},
		{name: "reuses provided", headerValue: "req-123", expectReuse: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestID := RequestID(r.Context())
				if requestID == "" {
					t.Fatal("expected request id in context")
				}
				if tc.expectReuse && requestID != tc.headerValue {
					t.Fatalf("expected request id %q to be reused, got %q", tc.headerValue, requestID)
				}
				if !tc.expectReuse && requestID == tc.headerValue {
					t.Fatalf("expected generated id to differ from header %q", tc.headerValue)
				}
			}))

			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.headerValue != "" {
				req.Header.Set("X-Request-Id", tc.headerValue)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			header := strings.TrimSpace(rec.Header().Get("X-Request-Id"))
			if header == "" {
				t.Fatal("expected response header to include request id")
			}
			if tc.expectReuse {
				if header != tc.headerValue {
					t.Fatalf("expected response header to reuse %q, got %q", tc.headerValue, header)
				}
			} else if header == tc.headerValue {
				t.Fatalf("expected response header to differ from original %q", tc.headerValue)
			}
		})
	}
}

func TestEnsureRequestID(t *testing.T) {
	t.Run("generates when missing", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()

		updated, id := EnsureRequestID(req, rec)
		if updated == nil {
			t.Fatal("expected request to be returned")
		}
		if id == "" {
			t.Fatal("expected generated request id")
		}
		if got := RequestID(updated.Context()); got != id {
			t.Fatalf("expected context to contain %q, got %q", id, got)
		}
		if header := strings.TrimSpace(rec.Header().Get("X-Request-Id")); header != id {
			t.Fatalf("expected response header to mirror id %q, got %q", id, header)
		}
		if header := strings.TrimSpace(updated.Header.Get("X-Request-Id")); header != id {
			t.Fatalf("expected request header to contain id %q, got %q", id, header)
		}
	})

	t.Run("reuses context identifier", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		ctx := context.WithValue(req.Context(), requestIDContextKey, "existing")
		req = req.WithContext(ctx)
		rec := httptest.NewRecorder()

		updated, id := EnsureRequestID(req, rec)
		if id != "existing" {
			t.Fatalf("expected to reuse existing id, got %q", id)
		}
		if updated != req {
			t.Fatal("expected request not to be replaced when context already populated")
		}
		if header := strings.TrimSpace(rec.Header().Get("X-Request-Id")); header != id {
			t.Fatalf("expected response header to mirror existing id %q, got %q", id, header)
		}
	})

	t.Run("handles nil writer", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)

		updated, id := EnsureRequestID(req, nil)
		if updated == nil || id == "" {
			t.Fatal("expected request and id when writer absent")
		}
		if header := strings.TrimSpace(updated.Header.Get("X-Request-Id")); header != id {
			t.Fatalf("expected request header to contain id %q, got %q", id, header)
		}
	})
}

func TestLoggerLogIncludesContextAttributes(t *testing.T) {
	handler := &recordingHandler{}
	logger := &Logger{logger: slog.New(handler), salt: "salt"}

	ctx := WithActor(context.Background(), "actor-1")
	ctx = context.WithValue(ctx, requestIDContextKey, "req-xyz")

	event := Event{
		Name:       "plan.approved",
		Outcome:    "success",
		Target:     "plan-123",
		Capability: "plans:approve",
		Details:    map[string]any{"count": 1},
	}

	logger.Info(ctx, event)

	if len(handler.records) != 1 {
		t.Fatalf("expected one record to be captured, got %d", len(handler.records))
	}

	record := handler.records[0]
	if record.Message != "gateway.audit.info" {
		t.Fatalf("unexpected log message: %s", record.Message)
	}

	attrs := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value.Any()
		return true
	})

	for _, key := range []string{"event", "outcome", "target", "actor_id", "request_id", "details"} {
		if _, ok := attrs[key]; !ok {
			t.Fatalf("expected attribute %q to be present", key)
		}
	}
	if attrs["event"] != event.Name {
		t.Fatalf("expected event name %q, got %v", event.Name, attrs["event"])
	}
	if attrs["request_id"] != "req-xyz" {
		t.Fatalf("expected request id attr to be req-xyz, got %v", attrs["request_id"])
	}
	details, ok := attrs["details"].(map[string]any)
	if !ok {
		t.Fatalf("expected details to be a map, got %T", attrs["details"])
	}
	if !reflect.DeepEqual(details, event.Details) {
		t.Fatalf("expected details %v, got %v", event.Details, details)
	}
}

func TestHashIdentityIgnoresEmptyParts(t *testing.T) {
	logger := &Logger{salt: "pepper"}
	got := logger.HashIdentity(" user ", "", "service")

	expected := func() string {
		h := sha256.New()
		h.Write([]byte("pepper"))
		for _, part := range []string{"user", "service"} {
			h.Write([]byte("|"))
			h.Write([]byte(part))
		}
		return hex.EncodeToString(h.Sum(nil))
	}()

	if got != expected {
		t.Fatalf("HashIdentity() = %q, want %q", got, expected)
	}
}

func TestRequestID(t *testing.T) {
	if id := RequestID(nil); id != "" {
		t.Fatalf("expected empty request id for nil context, got %q", id)
	}

	ctx := context.WithValue(context.Background(), requestIDContextKey, "req-1")
	if id := RequestID(ctx); id != "req-1" {
		t.Fatalf("expected request id req-1, got %q", id)
	}

	if id := RequestID(context.Background()); id != "" {
		t.Fatalf("expected empty request id when not set, got %q", id)
	}
}

func TestSanitizeDetails(t *testing.T) {
	err := errors.New("boom")
	input := map[string]any{
		"nil":      nil,
		"stringer": customStringer{},
		"error":    err,
		"bool":     true,
		"int":      42,
		"slice":    []string{"a"},
		"map":      map[string]any{"nested": "ok"},
		"custom":   customType{},
	}

	sanitized := SanitizeDetails(input)
	if sanitized == nil {
		t.Fatal("expected sanitized map")
	}
	if _, exists := sanitized["nil"]; !exists {
		t.Fatal("expected nil key to be present")
	}
	if sanitized["stringer"].(string) != "stringer" {
		t.Fatalf("expected stringer to be converted, got %v", sanitized["stringer"])
	}
	if sanitized["error"].(string) != "boom" {
		t.Fatalf("expected error to be string, got %v", sanitized["error"])
	}
	if sanitized["custom"].(string) == "" {
		t.Fatalf("expected custom type to be stringified")
	}

	if sanitized["slice"].([]string)[0] != "a" {
		t.Fatalf("expected slice preserved, got %v", sanitized["slice"])
	}
	if !reflect.DeepEqual(sanitized["map"], input["map"]) {
		t.Fatalf("expected map preserved, got %v", sanitized["map"])
	}

	if result := SanitizeDetails(nil); result != nil {
		t.Fatalf("expected nil input to return nil, got %v", result)
	}
}
