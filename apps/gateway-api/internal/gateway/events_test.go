package gateway

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientIPFromRequestRejectsSpoofedForwardedForFromUntrustedSource(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "203.0.113.10:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")

	ip := clientIPFromRequest(req, nil)
	if ip != "203.0.113.10" {
		t.Fatalf("expected remote addr, got %q", ip)
	}
}

func TestClientIPFromRequestAcceptsForwardedForFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.1.2.3")

	ip := clientIPFromRequest(req, []*net.IPNet{trustedNet})
	if ip != "198.51.100.9" {
		t.Fatalf("expected forwarded client ip, got %q", ip)
	}
}

func TestClientIPFromRequestFallsBackWhenForwardedForInvalid(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "not-an-ip")

	ip := clientIPFromRequest(req, []*net.IPNet{trustedNet})
	if ip != "10.1.2.3" {
		t.Fatalf("expected remote addr fallback, got %q", ip)
	}
}

func TestClientIPFromRequestAcceptsRealIPHeaderFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Real-IP", "198.51.100.10")

	ip := clientIPFromRequest(req, []*net.IPNet{trustedNet})
	if ip != "198.51.100.10" {
		t.Fatalf("expected real ip header, got %q", ip)
	}
}
