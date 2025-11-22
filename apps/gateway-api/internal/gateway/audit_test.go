package gateway

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func mustTrustedProxies(t *testing.T, entries ...string) []*net.IPNet {
	t.Helper()
	proxies, err := ParseTrustedProxyCIDRs(entries)
	if err != nil {
		t.Fatalf("failed to parse trusted proxies: %v", err)
	}
	return proxies
}

func TestClientIP(t *testing.T) {
	tests := []struct {
		name      string
		remote    string
		forwarded string
		proxies   []*net.IPNet
		want      string
	}{
		{
			name:   "remote address used when no proxies trusted",
			remote: "198.51.100.10:443",
			want:   "198.51.100.10",
		},
		{
			name:      "trusted proxy forwards first client",
			remote:    "192.0.2.10:443",
			forwarded: "203.0.113.5, 192.0.2.10",
			proxies:   mustTrustedProxies(t, "192.0.2.0/24"),
			want:      "203.0.113.5",
		},
		{
			name:      "spoofed forwarded header ignored",
			remote:    "198.51.100.20:443",
			forwarded: "203.0.113.9",
			want:      "198.51.100.20",
		},
		{
			name:      "malformed remote addr returns raw host",
			remote:    "not-a-host",
			forwarded: "",
			want:      "not-a-host",
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

			got := ClientIP(req, tt.proxies)
			if got != tt.want {
				t.Fatalf("ClientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMergeDetails(t *testing.T) {
	base := map[string]any{"provider": "openrouter"}
	extras := map[string]any{"status": "success"}

	merged := mergeDetails(base, extras)
	if len(merged) != 2 {
		t.Fatalf("expected merged map size 2, got %d", len(merged))
	}
	if merged["provider"] != "openrouter" || merged["status"] != "success" {
		t.Fatalf("unexpected merged values: %#v", merged)
	}
}

func TestRedirectHashIsStable(t *testing.T) {
	value := "https://app.example.com/callback"
	first := redirectHash(value)
	second := redirectHash(value)
	if first == "" || second == "" {
		t.Fatal("expected non-empty hash")
	}
	if first != second {
		t.Fatalf("expected stable hash, got %q and %q", first, second)
	}
	if first == value {
		t.Fatalf("hash should not expose original value")
	}
}
