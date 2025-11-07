package gateway

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

func TestClientIPFromRequestSkipsSpoofedForwardedForEntriesFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "203.0.113.5, 198.51.100.9, 10.1.2.3")

	ip := clientIPFromRequest(req, []*net.IPNet{trustedNet})
	if ip != "198.51.100.9" {
		t.Fatalf("expected to ignore spoofed entries and return %q, got %q", "198.51.100.9", ip)
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

func TestParseTrustedProxyCIDRsNormalizesIPv4(t *testing.T) {
	proxies, err := parseTrustedProxyCIDRs([]string{"192.0.2.10"})
	if err != nil {
		t.Fatalf("unexpected error parsing proxies: %v", err)
	}
	if len(proxies) != 1 {
		t.Fatalf("expected 1 proxy entry, got %d", len(proxies))
	}
	target := net.ParseIP("192.0.2.10")
	if target == nil {
		t.Fatalf("failed to parse target ip")
	}
	if !proxies[0].Contains(target) {
		t.Fatalf("expected proxy network to contain %q", target)
	}
}

func TestEventsHandlerPropagatesUpstreamErrors(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream failure", http.StatusServiceUnavailable)
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 from gateway, got %d", rec.Code)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "upstream failure" {
		t.Fatalf("expected upstream body to be forwarded, got %q", body)
	}
}

func TestEventsHandlerReturnsBadGatewayOnUpstreamTimeout(t *testing.T) {
	client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return nil, context.DeadlineExceeded
	})}
	handler := NewEventsHandler(client, "http://orchestrator", 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when upstream call fails, got %d", rec.Code)
	}
}

func TestEventsHandlerEmitsHeartbeats(t *testing.T) {
	block := make(chan struct{})
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("orchestrator recorder missing flusher")
		}
		flusher.Flush()
		<-block
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 10*time.Millisecond, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil).WithContext(ctx)
	req.Header.Set("Accept", "text/event-stream")
	rec := newFlushingRecorder()

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.Body.String(), ": ping") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(rec.Body.String(), ": ping") {
		t.Fatalf("expected heartbeat payload, got %q", rec.Body.String())
	}

	cancel()
	close(block)
	<-done
}

func TestEventsHandlerReleasesLimiterOnWriterErrors(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("orchestrator recorder missing flusher")
		}
		flusher.Flush()
		<-r.Context().Done()
	}))
	defer orchestrator.Close()

	limiter := newConnectionLimiter(1)
	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 10*time.Millisecond, limiter, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	req.RemoteAddr = "203.0.113.5:1234"
	req.Header.Set("Accept", "text/event-stream")

	rec := newHangingRecorder()

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	time.Sleep(25 * time.Millisecond)
	if limiter.Acquire("203.0.113.5") {
		t.Fatal("expected limiter to enforce single connection while stream active")
	}

	close(rec.block)
	<-done

	if !limiter.Acquire("203.0.113.5") {
		t.Fatal("expected limiter count to drop after stream ended")
	}
	limiter.Release("203.0.113.5")
}

type hangingRecorder struct {
	*httptest.ResponseRecorder
	block chan struct{}
}

func newHangingRecorder() *hangingRecorder {
	return &hangingRecorder{ResponseRecorder: httptest.NewRecorder(), block: make(chan struct{})}
}

func (r *hangingRecorder) Write(p []byte) (int, error) {
	<-r.block
	return 0, io.ErrClosedPipe
}

func (r *hangingRecorder) Flush() {}
