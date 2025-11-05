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

func TestHealthRouteReturnsReadinessData(t *testing.T) {
	mux := http.NewServeMux()
	started := time.Now().Add(-1 * time.Minute)
	RegisterHealthRoutes(mux, started)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
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

	req, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id=plan-deadbeef", nil)
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
		if path != "/plan/plan-deadbeef/events" {
			t.Fatalf("unexpected upstream path: %s", path)
		}
	case <-time.After(time.Second):
		t.Fatal("gateway did not call orchestrator")
	}
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

	req1, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id=plan-deadbeef", nil)
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

	req2, err := http.NewRequest(http.MethodGet, gatewaySrv.URL+"/events?plan_id=plan-deadbeef", nil)
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

	req1 := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
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

	req2 := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
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

	req1 := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
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

	req2 := httptest.NewRequest(http.MethodGet, "/events?plan_id=plan-deadbeef", nil)
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
