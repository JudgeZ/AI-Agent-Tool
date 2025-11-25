package main

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/JudgeZ/AI-Agent-Tool/apps/gateway-api/internal/gateway"
)

func TestNormalizeServiceURL(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		want      string
		wantError bool
	}{
		{name: "http", input: "http://example.com/path", want: "http://example.com/path"},
		{name: "https", input: "https://example.com", want: "https://example.com"},
		{name: "trailing slash trimmed", input: "https://example.com/path/", want: "https://example.com/path"},
		{name: "reject credentials", input: "https://user:pass@example.com", wantError: true},
		{name: "reject query", input: "https://example.com/path?token=secret", wantError: true},
		{name: "reject fragment", input: "https://example.com/path#frag", wantError: true},
		{name: "reject ftp", input: "ftp://example.com", wantError: true},
		{name: "require host", input: "https:///path", wantError: true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeServiceURL(tc.input)
			if tc.wantError {
				if err == nil {
					t.Fatalf("normalizeServiceURL(%q) expected error", tc.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeServiceURL(%q) unexpected error: %v", tc.input, err)
			}
			if got != tc.want {
				t.Fatalf("normalizeServiceURL(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestValidateServiceURL(t *testing.T) {
	t.Setenv("ORCHESTRATOR_URL", "https://example.com/api/")
	got, err := validateServiceURL("ORCHESTRATOR_URL", "http://default")
	if err != nil {
		t.Fatalf("validateServiceURL unexpected error: %v", err)
	}
	if got != "https://example.com/api" {
		t.Fatalf("validateServiceURL normalized = %q, want %q", got, "https://example.com/api")
	}

	t.Setenv("INDEXER_URL", "ftp://example.com")
	if _, err := validateServiceURL("INDEXER_URL", "http://default"); err == nil {
		t.Fatalf("expected validation error for unsupported scheme")
	}
}

func TestValidateServiceURLRequiresHTTPSInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("ORCHESTRATOR_URL", "http://example.com/api")
	if _, err := validateServiceURL("ORCHESTRATOR_URL", "http://127.0.0.1:4000"); err == nil {
		t.Fatalf("expected https requirement error in production")
	}

	t.Setenv("ORCHESTRATOR_URL", "https://example.com/api")
	if _, err := validateServiceURL("ORCHESTRATOR_URL", "http://127.0.0.1:4000"); err != nil {
		t.Fatalf("expected https url to be accepted in production, got %v", err)
	}
}

func TestValidateServiceURLRejectsFallbackLoopbackInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	if _, err := validateServiceURL("INDEXER_URL", "http://127.0.0.1:7071"); err == nil {
		t.Fatalf("expected fallback loopback to be rejected in production")
	}
}

func TestValidateServiceURLRunModeEnterpriseRequiresHTTPS(t *testing.T) {
	t.Setenv("RUN_MODE", "enterprise")
	t.Setenv("INDEXER_URL", "http://example.com")
	if _, err := validateServiceURL("INDEXER_URL", "http://127.0.0.1:7071"); err == nil {
		t.Fatalf("expected enterprise mode to require https")
	}
}

func TestTrustedProxyCIDRsFromEnv(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want []string
	}{
		{
			name: "unset",
			env:  "",
			want: nil,
		},
		{
			name: "only blanks",
			env:  " , ,  ",
			want: nil,
		},
		{
			name: "single value",
			env:  "10.0.0.0/8",
			want: []string{"10.0.0.0/8"},
		},
		{
			name: "multiple with whitespace and empties",
			env:  " 10.0.0.0/8 , ,192.168.0.0/16, \t",
			want: []string{"10.0.0.0/8", "192.168.0.0/16"},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GATEWAY_TRUSTED_PROXY_CIDRS", tc.env)

			got := trustedProxyCIDRsFromEnv()
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("trustedProxyCIDRsFromEnv() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAllowInsecureStateCookieFromEnv(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want bool
	}{
		{name: "unset", env: "", want: false},
		{name: "true", env: "true", want: true},
		{name: "numeric true", env: "1", want: true},
		{name: "mixed case", env: "YeS", want: true},
		{name: "false default", env: "no", want: false},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("OAUTH_ALLOW_INSECURE_STATE_COOKIE", tc.env)

			if got := allowInsecureStateCookieFromEnv(); got != tc.want {
				t.Fatalf("allowInsecureStateCookieFromEnv() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMaxRequestBodyBytesFromEnv(t *testing.T) {
	defaults := gateway.DefaultMaxRequestBodyBytes()

	cases := []struct {
		name string
		env  string
		want int64
	}{
		{name: "unset", env: "", want: defaults},
		{name: "invalid number", env: "abc", want: defaults},
		{name: "zero", env: "0", want: defaults},
		{name: "negative", env: "-5", want: defaults},
		{name: "valid", env: "123456", want: 123456},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GATEWAY_MAX_REQUEST_BODY_BYTES", tc.env)

			if got := maxRequestBodyBytesFromEnv(); got != tc.want {
				t.Fatalf("maxRequestBodyBytesFromEnv() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestRateLimitedResponsesIncludeRequestID(t *testing.T) {
	t.Setenv("GATEWAY_HTTP_RATE_LIMIT_MAX", "1")
	t.Setenv("GATEWAY_HTTP_RATE_LIMIT_WINDOW", "1m")

	limiter := gateway.NewGlobalRateLimiter(nil)
	handler := buildHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), limiter, gateway.DefaultMaxRequestBodyBytes())

	first := httptest.NewRecorder()
	firstReq := httptest.NewRequest(http.MethodGet, "/", nil)
	firstReq.RemoteAddr = "203.0.113.50:1000"
	handler.ServeHTTP(first, firstReq)
	if first.Code != http.StatusOK {
		t.Fatalf("expected first request to succeed, got %d", first.Code)
	}

	second := httptest.NewRecorder()
	secondReq := httptest.NewRequest(http.MethodGet, "/", nil)
	secondReq.RemoteAddr = "203.0.113.50:2000"
	handler.ServeHTTP(second, secondReq)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second request to be rate limited, got %d", second.Code)
	}
	if requestID := strings.TrimSpace(second.Header().Get("X-Request-Id")); requestID == "" {
		t.Fatal("expected rate-limited response to include X-Request-Id header")
	}
}

func TestValidateStateCookieConfig(t *testing.T) {
	cases := []struct {
		name            string
		allowInsecure   bool
		nodeEnv         string
		runMode         string
		wantErrContains string
	}{
		{
			name:          "insecure disabled",
			allowInsecure: false,
			nodeEnv:       "production",
			runMode:       "enterprise",
		},
		{
			name:          "development allowed",
			allowInsecure: true,
			nodeEnv:       "development",
			runMode:       "local",
		},
		{
			name:            "production disallowed",
			allowInsecure:   true,
			nodeEnv:         "production",
			wantErrContains: "NODE_ENV",
		},
		{
			name:            "prod alias disallowed",
			allowInsecure:   true,
			nodeEnv:         "PrOd",
			wantErrContains: "NODE_ENV",
		},
		{
			name:            "enterprise disallowed",
			allowInsecure:   true,
			runMode:         "Enterprise",
			wantErrContains: "RUN_MODE",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NODE_ENV", tc.nodeEnv)
			t.Setenv("RUN_MODE", tc.runMode)

			err := validateStateCookieConfig(tc.allowInsecure)
			if tc.wantErrContains == "" {
				if err != nil {
					t.Fatalf("validateStateCookieConfig() unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("validateStateCookieConfig() expected error containing %q, got nil", tc.wantErrContains)
			}
			if !strings.Contains(err.Error(), tc.wantErrContains) {
				t.Fatalf("validateStateCookieConfig() error %q does not contain %q", err.Error(), tc.wantErrContains)
			}
		})
	}
}
