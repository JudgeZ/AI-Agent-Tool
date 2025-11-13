package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/gateway"
)

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
