package gateway

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type recordedEntry struct {
	Level   slog.Level
	Message string
	Attrs   []slog.Attr
}

type recordLog struct {
	mu      sync.Mutex
	entries []recordedEntry
}

type recordingHandler struct {
	log       *recordLog
	baseAttrs []slog.Attr
}

func newRecordingHandler() *recordingHandler {
	return &recordingHandler{log: &recordLog{}}
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool {
	return true
}

func (h *recordingHandler) Handle(_ context.Context, record slog.Record) error {
	attrs := append([]slog.Attr{}, h.baseAttrs...)
	record.Attrs(func(attr slog.Attr) bool {
		attrs = append(attrs, attr)
		return true
	})

	h.log.mu.Lock()
	defer h.log.mu.Unlock()
	h.log.entries = append(h.log.entries, recordedEntry{
		Level:   record.Level,
		Message: record.Message,
		Attrs:   attrs,
	})
	return nil
}

func (h *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	base := append([]slog.Attr{}, h.baseAttrs...)
	base = append(base, attrs...)
	return &recordingHandler{log: h.log, baseAttrs: base}
}

func (h *recordingHandler) WithGroup(string) slog.Handler {
	return &recordingHandler{log: h.log, baseAttrs: append([]slog.Attr{}, h.baseAttrs...)}
}

func (h *recordingHandler) Records() []recordedEntry {
	h.log.mu.Lock()
	defer h.log.mu.Unlock()
	out := make([]recordedEntry, len(h.log.entries))
	copy(out, h.log.entries)
	return out
}

func setAuditLoggerForTest(t *testing.T, handler slog.Handler) {
	t.Helper()
	auditLoggerOnce = sync.Once{}
	auditLogger = nil

	auditLoggerOnce.Do(func() {
		auditLogger = slog.New(handler).With(
			slog.String("component", "gateway"),
			slog.String("category", "audit"),
		)
	})

	t.Cleanup(func() {
		auditLoggerOnce = sync.Once{}
		auditLogger = nil
	})
}

func attrsToMap(attrs []slog.Attr) map[string]slog.Value {
	m := make(map[string]slog.Value, len(attrs))
	for _, attr := range attrs {
		m[attr.Key] = attr.Value
	}
	return m
}

func mustTrustedProxies(t *testing.T, entries ...string) []*net.IPNet {
	t.Helper()
	proxies, err := parseTrustedProxyCIDRs(entries)
	if err != nil {
		t.Fatalf("failed to parse trusted proxies: %v", err)
	}
	return proxies
}

func TestAuditRequestAttrs(t *testing.T) {
	tests := []struct {
		name      string
		forwarded string
		remote    string
		requestID string
		proxies   []*net.IPNet
		want      map[string]string
	}{
		{
			name:      "ignores spoofed header without trusted proxy",
			forwarded: "203.0.113.1, 70.41.3.18",
			remote:    "192.0.2.1:1234",
			requestID: "req-123",
			want: map[string]string{
				"client_ip":  "192.0.2.1",
				"request_id": "req-123",
			},
		},
		{
			name:   "remote ip without request id",
			remote: "198.51.100.23:8080",
			want: map[string]string{
				"client_ip": "198.51.100.23",
			},
		},
		{
			name:      "uses forwarded when remote is trusted",
			remote:    "192.0.2.10:443",
			proxies:   mustTrustedProxies(t, "192.0.2.0/24"),
			forwarded: "198.51.100.1, 192.0.2.10",
			want: map[string]string{
				"client_ip": "198.51.100.1",
			},
		},
		{
			name:      "falls back when forwarded only trusted proxies",
			remote:    "192.0.2.10:443",
			proxies:   mustTrustedProxies(t, "192.0.2.0/24"),
			forwarded: "192.0.2.20, 192.0.2.10",
			want: map[string]string{
				"client_ip": "192.0.2.10",
			},
		},
		{
			name:   "malformed remote addr",
			remote: "invalid-addr",
			want: map[string]string{
				"client_ip": "invalid-addr",
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "https://example.com", nil)
			req.RemoteAddr = tt.remote
			if tt.forwarded != "" {
				req.Header.Set("X-Forwarded-For", tt.forwarded)
			}
			if tt.requestID != "" {
				req.Header.Set("X-Request-Id", tt.requestID)
			}

			attrs := auditRequestAttrs(req, tt.proxies)
			got := make(map[string]string, len(attrs))
			for _, attr := range attrs {
				got[attr.Key] = attr.Value.String()
			}

			if len(got) != len(tt.want) {
				t.Fatalf("unexpected attr count: got %d want %d (%v)", len(got), len(tt.want), got)
			}
			for key, want := range tt.want {
				if got[key] != want {
					t.Fatalf("attr %s = %q, want %q", key, got[key], want)
				}
			}
		})
	}
}

func TestLogAuditEmitsExpectedFields(t *testing.T) {
	handler := newRecordingHandler()
	setAuditLoggerForTest(t, handler)

	req := httptest.NewRequest(http.MethodGet, "https://example.com", nil)
	req.RemoteAddr = "192.0.2.10:443"
	req.Header.Set("X-Forwarded-For", "198.51.100.1, 192.0.2.10")
	req.Header.Set("X-Request-Id", "req-456")

	proxies := mustTrustedProxies(t, "192.0.2.0/24")
	attrs := auditRequestAttrs(req, proxies)
	logAudit(context.Background(), "test_action", "success", attrs...)

	records := handler.Records()
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}

	entry := records[0]
	if entry.Level != slog.LevelInfo {
		t.Fatalf("level = %v, want %v", entry.Level, slog.LevelInfo)
	}
	if entry.Message != "audit.event" {
		t.Fatalf("message = %q, want %q", entry.Message, "audit.event")
	}

	attrValues := attrsToMap(entry.Attrs)
	expected := map[string]string{
		"component":  "gateway",
		"category":   "audit",
		"action":     "test_action",
		"result":     "success",
		"client_ip":  "198.51.100.1",
		"request_id": "req-456",
	}

	for key, want := range expected {
		value, ok := attrValues[key]
		if !ok {
			t.Fatalf("expected attr %s missing", key)
		}
		if value.String() != want {
			t.Fatalf("attr %s = %q, want %q", key, value.String(), want)
		}
	}
}
