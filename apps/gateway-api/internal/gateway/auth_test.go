package gateway

import "testing"

func TestValidateClientRedirect_AllowsConfiguredOrigins(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://other.example.com/base")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://app.example.com/callback"); err != nil {
		t.Fatalf("expected redirect to be allowed, got error: %v", err)
	}
}

func TestValidateClientRedirect_RejectsUnauthorizedOrigin(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://evil.example.com/callback"); err == nil {
		t.Fatal("expected redirect to be rejected")
	}
}

func TestValidateClientRedirect_UsesRedirectBaseWhenAllowlistEmpty(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "")
	t.Setenv("OAUTH_REDIRECT_BASE", "https://ui.example.com/app")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("https://ui.example.com/complete"); err != nil {
		t.Fatalf("expected redirect based on base URL to be allowed, got error: %v", err)
	}
}

func TestValidateClientRedirect_AllowsLoopbackHTTP(t *testing.T) {
	t.Setenv("OAUTH_ALLOWED_REDIRECT_ORIGINS", "https://ui.example.com")
	allowedRedirectOrigins = loadAllowedRedirectOrigins()

	if err := validateClientRedirect("http://127.0.0.1:3000/callback"); err != nil {
		t.Fatalf("expected loopback redirect to be allowed, got error: %v", err)
	}
	if err := validateClientRedirect("http://localhost:8080/callback"); err != nil {
		t.Fatalf("expected localhost redirect to be allowed, got error: %v", err)
	}
}
