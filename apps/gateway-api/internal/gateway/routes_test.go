package gateway

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const routesPlanID = "plan-550e8400-e29b-41d4-a716-446655440000"

func TestHealthRouteReturnsReadinessData(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			t.Fatalf("unexpected orchestrator path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","details":{}}`))
	}))
	defer orchestrator.Close()

	indexer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("unexpected indexer path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer indexer.Close()

	t.Setenv("ORCHESTRATOR_URL", orchestrator.URL)
	t.Setenv("INDEXER_URL", indexer.URL)
	ResetOrchestratorClient()

	mux := http.NewServeMux()
	started := time.Now().Add(-1 * time.Minute)
	RegisterHealthRoutes(mux, started)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	if contentType := rec.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("expected JSON content type, got %s", contentType)
	}

	var body healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}

	if body.Status != "ok" {
		t.Fatalf("unexpected status: %s", body.Status)
	}

	if _, ok := body.Details["orchestrator"]; !ok {
		t.Fatalf("expected orchestrator details, got %+v", body.Details)
	}
	if body.Details["orchestrator"].Status != "pass" {
		t.Fatalf("expected orchestrator pass, got %+v", body.Details["orchestrator"])
	}
	if _, ok := body.Details["indexer"]; !ok {
		t.Fatalf("expected indexer details, got %+v", body.Details)
	}
	if body.Details["indexer"].Status != "pass" {
		t.Fatalf("expected indexer pass, got %+v", body.Details["indexer"])
	}
	if body.UptimeSeconds <= 0 {
		t.Fatalf("expected positive uptime, got %f", body.UptimeSeconds)
	}
}

func TestEventsHandlerForwardsSSEStream(t *testing.T) {
	planPath := make(chan string, 1)
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		planPath <- r.URL.Path
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("upstream recorder missing flusher")
		}
		events := []string{"data: first\n\n", "data: second\n\n"}
		for _, evt := range events {
			if _, err := io.WriteString(w, evt); err != nil {
				t.Fatalf("failed to write upstream event: %v", err)
			}
			flusher.Flush()
		}
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 50*time.Millisecond, nil, nil)

	mux := http.NewServeMux()
	mux.Handle("/events", handler)

	gatewaySrv := httptest.NewServer(mux)
	defer gatewaySrv.Close()

	req, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id="+routesPlanID, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := gatewaySrv.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from gateway, got %d", resp.StatusCode)
	}

	if contentType := resp.Header.Get("Content-Type"); !strings.Contains(contentType, "text/event-stream") {
		t.Fatalf("expected text/event-stream, got %s", contentType)
	}

	reader := bufio.NewReader(resp.Body)
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}

	bodyStr := string(data)
	if !strings.Contains(bodyStr, "data: first") || !strings.Contains(bodyStr, "data: second") {
		t.Fatalf("gateway did not forward SSE events: %q", bodyStr)
	}

	select {
	case path := <-planPath:
		if path != "/plan/"+routesPlanID+"/events" {
			t.Fatalf("unexpected upstream path: %s", path)
		}
	case <-time.After(time.Second):
		t.Fatal("gateway did not call orchestrator")
	}
}

func TestEventsHandlerPropagatesForwardingHeaders(t *testing.T) {
	type headerSnapshot struct {
		agent        string
		requestID    string
		forwardedFor string
		realIP       []string
	}

	captured := make(chan headerSnapshot, 1)
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured <- headerSnapshot{
			agent:        r.Header.Get("X-Agent"),
			requestID:    r.Header.Get("X-Request-Id"),
			forwardedFor: r.Header.Get("X-Forwarded-For"),
			realIP:       r.Header.Values("X-Real-IP"),
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("upstream recorder missing flusher")
		}
		if _, err := io.WriteString(w, "data: ok\n\n"); err != nil {
			t.Fatalf("failed to write upstream event: %v", err)
		}
		flusher.Flush()
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, nil, nil)

	mux := http.NewServeMux()
	mux.Handle("/events", handler)

	gatewaySrv := httptest.NewServer(mux)
	defer gatewaySrv.Close()

	req, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id="+routesPlanID, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("X-Agent", "gui-client")
	req.Header.Set("X-Request-ID", "req-abc123")
	req.Header.Set("X-Forwarded-For", "198.51.100.10")
	req.Header.Set("X-Real-IP", "198.51.100.11")

	resp, err := gatewaySrv.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from gateway, got %d", resp.StatusCode)
	}

	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}

	select {
	case snapshot := <-captured:
		if snapshot.agent != "gui-client" {
			t.Fatalf("unexpected X-Agent header: %s", snapshot.agent)
		}
		if snapshot.requestID != "req-abc123" {
			t.Fatalf("unexpected X-Request-ID header: %s", snapshot.requestID)
		}
		parts := strings.Split(snapshot.forwardedFor, ",")
		if len(parts) < 2 {
			t.Fatalf("expected forwarded chain to include gateway, got %q", snapshot.forwardedFor)
		}
		first := strings.TrimSpace(parts[0])
		expectedFirst := "198.51.100.10"
		if first != expectedFirst {
			t.Fatalf("expected first forwarded entry %q, got %q", expectedFirst, first)
		}
		last := strings.TrimSpace(parts[len(parts)-1])
		expectedGateway := hostOnly(gatewaySrv.Listener.Addr())
		if last != expectedGateway {
			t.Fatalf("expected gateway addr %q, got %q", expectedGateway, last)
		}
		if len(snapshot.realIP) == 0 {
			t.Fatal("expected X-Real-IP headers to be forwarded")
		}
		realFirst := strings.TrimSpace(snapshot.realIP[0])
		if realFirst != "198.51.100.11" {
			t.Fatalf("expected first X-Real-IP value %q, got %q", "198.51.100.11", realFirst)
		}
		realLast := strings.TrimSpace(snapshot.realIP[len(snapshot.realIP)-1])
		if realLast != expectedGateway {
			t.Fatalf("expected gateway real ip %q, got %q", expectedGateway, realLast)
		}
	case <-time.After(time.Second):
		t.Fatal("gateway did not forward headers")
	}
}

func hostOnly(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

func TestEventsHandlerRejectsInvalidPlanID(t *testing.T) {
	handler := NewEventsHandler(nil, "http://orchestrator", 0, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/events?plan_id=not-valid", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid plan_id, got %d", rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "plan_id is invalid") {
		t.Fatalf("expected validation message, got %q", rec.Body.String())
	}
}

func TestEventsHandlerEnforcesConnectionLimit(t *testing.T) {
	block := make(chan struct{})
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("upstream recorder missing flusher")
		}
		if _, err := io.WriteString(w, "data: first\n\n"); err != nil {
			t.Fatalf("failed to write upstream event: %v", err)
		}
		flusher.Flush()
		<-block
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, newConnectionLimiter(1), nil)
	mux := http.NewServeMux()
	mux.Handle("/events", handler)

	gatewaySrv := httptest.NewServer(mux)
	defer gatewaySrv.Close()

	req1, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id="+routesPlanID, nil)
	if err != nil {
		t.Fatalf("failed to create first request: %v", err)
	}
	req1.Header.Set("Accept", "text/event-stream")
	resp1, err := gatewaySrv.Client().Do(req1)
	if err != nil {
		t.Fatalf("first request failed: %v", err)
	}
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for first stream, got %d", resp1.StatusCode)
	}

	req2, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id="+routesPlanID, nil)
	if err != nil {
		t.Fatalf("failed to create second request: %v", err)
	}
	req2.Header.Set("Accept", "text/event-stream")
	resp2, err := gatewaySrv.Client().Do(req2)
	if err != nil {
		t.Fatalf("second request failed: %v", err)
	}
	if resp2.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 for second stream, got %d", resp2.StatusCode)
	}
	resp2.Body.Close()

	close(block)
	resp1.Body.Close()
}

func TestEventsHandlerLimiterRejectsSpoofedForwardedForFromUntrustedClient(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("upstream recorder missing flusher")
		}
		if _, err := io.WriteString(w, "data: first\n\n"); err != nil {
			t.Fatalf("failed to write upstream event: %v", err)
		}
		flusher.Flush()
		started <- struct{}{}
		<-release
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, newConnectionLimiter(1), nil)

	req1 := httptest.NewRequest(http.MethodGet, "/events?plan_id="+routesPlanID, nil)
	req1.RemoteAddr = "203.0.113.10:1234"
	req1.Header.Set("Accept", "text/event-stream")
	req1.Header.Set("X-Forwarded-For", "198.51.100.1")

	rec1 := newFlushingRecorder()
	done1 := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec1, req1)
		close(done1)
	}()

	<-started

	req2 := httptest.NewRequest(http.MethodGet, "/events?plan_id="+routesPlanID, nil)
	req2.RemoteAddr = "203.0.113.10:5678"
	req2.Header.Set("Accept", "text/event-stream")
	req2.Header.Set("X-Forwarded-For", "203.0.113.200")

	rec2 := newFlushingRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 for spoofed forwarded for, got %d", rec2.Code)
	}

	close(release)
	<-done1
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected first request to succeed, got %d", rec1.Code)
	}
}

func TestEventsHandlerLimiterHonorsTrustedProxyForwardedFor(t *testing.T) {
	_, trustedNet, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("failed to parse CIDR: %v", err)
	}

	started := make(chan struct{}, 2)
	release := make(chan struct{})
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("upstream recorder missing flusher")
		}
		if _, err := io.WriteString(w, "data: first\n\n"); err != nil {
			t.Fatalf("failed to write upstream event: %v", err)
		}
		flusher.Flush()
		started <- struct{}{}
		<-release
	}))
	defer orchestrator.Close()

	handler := NewEventsHandler(orchestrator.Client(), orchestrator.URL, 0, newConnectionLimiter(1), []*net.IPNet{trustedNet})

	req1 := httptest.NewRequest(http.MethodGet, "/events?plan_id="+routesPlanID, nil)
	req1.RemoteAddr = "10.1.2.3:1234"
	req1.Header.Set("Accept", "text/event-stream")
	req1.Header.Set("X-Forwarded-For", "198.51.100.1, 10.1.2.3")

	rec1 := newFlushingRecorder()
	done1 := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec1, req1)
		close(done1)
	}()

	<-started

	req2 := httptest.NewRequest(http.MethodGet, "/events?plan_id="+routesPlanID, nil)
	req2.RemoteAddr = "10.1.2.3:5678"
	req2.Header.Set("Accept", "text/event-stream")
	req2.Header.Set("X-Forwarded-For", "203.0.113.200, 10.1.2.3")

	rec2 := newFlushingRecorder()
	done2 := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec2, req2)
		close(done2)
	}()

	<-started

	close(release)
	<-done1
	<-done2

	if rec1.Code != http.StatusOK {
		t.Fatalf("expected first proxied request to succeed, got %d", rec1.Code)
	}
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected second proxied request to succeed, got %d", rec2.Code)
	}
}

type flushingRecorder struct {
	*httptest.ResponseRecorder
}

func newFlushingRecorder() *flushingRecorder {
	return &flushingRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (r *flushingRecorder) Flush() {}
