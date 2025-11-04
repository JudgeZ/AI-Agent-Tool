package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultHeartbeatInterval = 30 * time.Second
	heartbeatPayload         = ": ping\n\n"
)

var planIDPattern = regexp.MustCompile(`^plan-[0-9a-f]{8}$`)

type connectionLimiter struct {
	mu     sync.Mutex
	limit  int
	counts map[string]int
}

func newConnectionLimiter(limit int) *connectionLimiter {
	if limit <= 0 {
		return nil
	}
	return &connectionLimiter{
		limit:  limit,
		counts: make(map[string]int),
	}
}

func (l *connectionLimiter) Acquire(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	current := l.counts[key]
	if current >= l.limit {
		return false
	}
	l.counts[key] = current + 1
	return true
}

func (l *connectionLimiter) Release(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	current, ok := l.counts[key]
	if !ok {
		return
	}
	if current <= 1 {
		delete(l.counts, key)
		return
	}
	l.counts[key] = current - 1
}

// EventsHandler proxies Server-Sent Events streams from the orchestrator.
type EventsHandler struct {
	client            *http.Client
	orchestratorURL   string
	heartbeatInterval time.Duration
	limiter           *connectionLimiter
}

// NewEventsHandler constructs an SSE proxy handler that forwards requests to the orchestrator.
func NewEventsHandler(client *http.Client, orchestratorURL string, heartbeat time.Duration, limiter *connectionLimiter) *EventsHandler {
	if client == nil {
		client = &http.Client{}
	}
	orchestratorURL = strings.TrimRight(orchestratorURL, "/")
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeatInterval
	}
	return &EventsHandler{
		client:            client,
		orchestratorURL:   orchestratorURL,
		heartbeatInterval: heartbeat,
		limiter:           limiter,
	}
}

// RegisterEventRoutes wires the /events endpoint into the provided mux.
func RegisterEventRoutes(mux *http.ServeMux) {
	orchestratorURL := getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000")
	client, err := getOrchestratorClient()
	if err != nil {
		panic(fmt.Sprintf("failed to configure orchestrator client: %v", err))
	}
	maxConnections := getIntEnv("GATEWAY_SSE_MAX_CONNECTIONS_PER_IP", 4)
	handler := NewEventsHandler(client, orchestratorURL, 0, newConnectionLimiter(maxConnections))
	mux.Handle("/events", handler)
}

// ServeHTTP implements http.Handler for the EventsHandler.
func (h *EventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	planID := r.URL.Query().Get("plan_id")
	planID = strings.TrimSpace(planID)
	if planID == "" {
		http.Error(w, "plan_id is required", http.StatusBadRequest)
		return
	}
	if !planIDPattern.MatchString(planID) {
		http.Error(w, "plan_id is invalid", http.StatusBadRequest)
		return
	}

	clientIP := clientIPFromRequest(r)
	if h.limiter != nil {
		if !h.limiter.Acquire(clientIP) {
			http.Error(w, "too many concurrent event streams", http.StatusTooManyRequests)
			return
		}
		defer h.limiter.Release(clientIP)
	}

	upstreamURL := fmt.Sprintf("%s/plan/%s/events", h.orchestratorURL, url.PathEscape(planID))
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		http.Error(w, "failed to create upstream request", http.StatusInternalServerError)
		return
	}

	req.Header.Set("Accept", "text/event-stream")
	if auth := r.Header.Get("Authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if lastEventID := r.Header.Get("Last-Event-ID"); lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		http.Error(w, "failed to contact orchestrator", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if len(body) == 0 {
			http.Error(w, http.StatusText(resp.StatusCode), resp.StatusCode)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(resp.StatusCode)
		w.Write(body)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	writer := &flushingWriter{w: w, flusher: flusher}
	errCh := make(chan error, 1)

	go func() {
		_, err := io.Copy(writer, resp.Body)
		errCh <- err
	}()

	ticker := time.NewTicker(h.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			resp.Body.Close()
			<-errCh
			return
		case err := <-errCh:
			if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
				// Best-effort error propagation by terminating the stream.
				http.Error(w, "stream interrupted", http.StatusBadGateway)
			}
			return
		case <-ticker.C:
			if _, err := writer.Write([]byte(heartbeatPayload)); err != nil {
				resp.Body.Close()
				<-errCh
				return
			}
		}
	}
}

type flushingWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	mu      sync.Mutex
}

func (fw *flushingWriter) Write(p []byte) (int, error) {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	n, err := fw.w.Write(p)
	if n > 0 {
		fw.flusher.Flush()
	}
	return n, err
}

func clientIPFromRequest(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		candidate := strings.TrimSpace(parts[0])
		if candidate != "" {
			return candidate
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func getIntEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < 0 {
		return 0
	}
	return value
}
