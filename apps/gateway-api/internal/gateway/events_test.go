package gateway

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestClientIPRejectsSpoofedForwardedForFromUntrustedSource(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "203.0.113.10:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")

	ip := clientIP(req, nil)
	if ip != "203.0.113.10" {
		t.Fatalf("expected remote addr, got %q", ip)
	}
}

func TestClientIPAcceptsForwardedForFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.1.2.3")

	ip := clientIP(req, []*net.IPNet{trustedNet})
	if ip != "198.51.100.9" {
		t.Fatalf("expected forwarded client ip, got %q", ip)
	}
}

func TestClientIPSkipsSpoofedForwardedForEntriesFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "203.0.113.5, 198.51.100.9, 10.1.2.3")

	ip := clientIP(req, []*net.IPNet{trustedNet})
	if ip != "198.51.100.9" {
		t.Fatalf("expected to ignore spoofed entries and return %q, got %q", "198.51.100.9", ip)
	}
}

func TestClientIPFallsBackWhenForwardedForInvalid(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Forwarded-For", "not-an-ip")

	ip := clientIP(req, []*net.IPNet{trustedNet})
	if ip != "10.1.2.3" {
		t.Fatalf("expected remote addr fallback, got %q", ip)
	}
}

func TestClientIPAcceptsRealIPHeaderFromTrustedProxy(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/events", nil)
	req.RemoteAddr = "10.1.2.3:4321"
	req.Header.Set("X-Real-IP", "198.51.100.10")

	ip := clientIP(req, []*net.IPNet{trustedNet})
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

func TestEventsHandlerForwardsUpstreamServerErrorBodies(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("orchestrator meltdown"))
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 from gateway, got %d", rec.Code)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "orchestrator meltdown" {
		t.Fatalf("expected upstream body to be forwarded, got %q", body)
	}
}

func TestEventsHandlerErrorsWhenResponseWriterLacksFlusher(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: ready\n\n"))
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec := newNonFlushingRecorder()

	handler.ServeHTTP(rec, req)

	if rec.StatusCode() != http.StatusInternalServerError {
		t.Fatalf("expected 500 when flusher unavailable, got %d", rec.StatusCode())
	}
	if body := rec.BodyString(); !strings.Contains(body, "streaming unsupported") {
		t.Fatalf("expected streaming unsupported message, got %q", body)
	}
}

func TestEventsHandlerReturnsBadGatewayOnStreamInterruption(t *testing.T) {
	client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		body := &failingReadCloser{}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       body,
		}, nil
	})}
	handler := NewEventsHandler(client, "http://orchestrator", time.Second, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec := newFlushingRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 after stream interruption, got %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "stream interrupted") {
		t.Fatalf("expected stream interrupted message, got %q", body)
	}
}

func TestEventsHandlerForwardsCookieHeaders(t *testing.T) {
	cookieCh := make(chan string, 1)

	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookieCh <- r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("orchestrator recorder missing flusher")
		}
		w.Write([]byte("data: connected\n\n"))
		flusher.Flush()
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	req.Header.Set("Cookie", "session=abc123")
	rec := newFlushingRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected proxied SSE request to succeed, got %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "data: connected") {
		t.Fatalf("expected SSE payload to be forwarded, got %q", body)
	}

	select {
	case cookie := <-cookieCh:
		if cookie != "session=abc123" {
			t.Fatalf("expected cookie header to be forwarded, got %q", cookie)
		}
	default:
		t.Fatal("expected orchestrator to receive cookie header")
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

func TestEventsHandlerTerminatesOnHeartbeatWriteFailure(t *testing.T) {
	body := newBlockingReadCloser()
	client := &http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       body,
		}, nil
	})}

	limiter := newConnectionLimiter(1)
	handler := NewEventsHandler(client, "http://orchestrator", 5*time.Millisecond, limiter, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
	req.RemoteAddr = "203.0.113.5:1234"
	req.Header.Set("Accept", "text/event-stream")

	rec := newHeartbeatRecorder()

	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("expected handler to terminate after heartbeat failure")
	}

	select {
	case <-body.closedNotify:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("expected upstream response body to be closed")
	}

	if !limiter.Acquire("203.0.113.5") {
		t.Fatal("expected limiter count to drop after heartbeat failure")
	}
	limiter.Release("203.0.113.5")
}

func TestParseTrustedProxyCIDRsRejectsInvalidEntries(t *testing.T) {
	_, err := parseTrustedProxyCIDRs([]string{"invalid-cidr"})
	if err == nil {
		t.Fatal("expected parse error for invalid CIDR entry")
	}
}

func TestRegisterEventRoutesPanicsOnInvalidTrustedProxyCIDR(t *testing.T) {
	t.Cleanup(func() {
		ResetOrchestratorClient()
	})
	SetOrchestratorClientFactory(func() (*http.Client, error) {
		return &http.Client{}, nil
	})

	mux := http.NewServeMux()

	require.Panics(t, func() {
		RegisterEventRoutes(mux, EventRouteConfig{TrustedProxyCIDRs: []string{"not-a-cidr"}})
	})
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

type heartbeatRecorder struct {
	*httptest.ResponseRecorder
}

func newHeartbeatRecorder() *heartbeatRecorder {
	return &heartbeatRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (r *heartbeatRecorder) Write(p []byte) (int, error) {
	if bytes.Equal(p, []byte(heartbeatPayload)) {
		return 0, io.ErrClosedPipe
	}
	return r.ResponseRecorder.Write(p)
}

func (r *heartbeatRecorder) Flush() {}

type nonFlushingRecorder struct {
	recorder *httptest.ResponseRecorder
}

func newNonFlushingRecorder() *nonFlushingRecorder {
	return &nonFlushingRecorder{recorder: httptest.NewRecorder()}
}

func (r *nonFlushingRecorder) Header() http.Header {
	return r.recorder.Header()
}

func (r *nonFlushingRecorder) Write(p []byte) (int, error) {
	return r.recorder.Write(p)
}

func (r *nonFlushingRecorder) WriteHeader(statusCode int) {
	r.recorder.WriteHeader(statusCode)
}

func (r *nonFlushingRecorder) StatusCode() int {
	return r.recorder.Code
}

func (r *nonFlushingRecorder) BodyString() string {
	return r.recorder.Body.String()
}

type failingReadCloser struct {
	reads int
}

func (f *failingReadCloser) Read(p []byte) (int, error) {
	if f.reads == 0 {
		f.reads++
		return 0, io.ErrUnexpectedEOF
	}
	return 0, io.EOF
}

func (f *failingReadCloser) Close() error { return nil }

type blockingReadCloser struct {
	once         sync.Once
	closed       chan struct{}
	closedNotify chan struct{}
}

func newBlockingReadCloser() *blockingReadCloser {
	return &blockingReadCloser{closed: make(chan struct{}), closedNotify: make(chan struct{})}
}

func (b *blockingReadCloser) Read(p []byte) (int, error) {
	<-b.closed
	return 0, io.EOF
}

func (b *blockingReadCloser) Close() error {
	b.once.Do(func() {
		close(b.closed)
		close(b.closedNotify)
	})
	return nil
}
