package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	defaultHeartbeatInterval = 30 * time.Second
	heartbeatPayload         = ": ping\n\n"
)

// EventsHandler proxies Server-Sent Events streams from the orchestrator.
type EventsHandler struct {
	client            *http.Client
	orchestratorURL   string
	heartbeatInterval time.Duration
}

// NewEventsHandler constructs an SSE proxy handler that forwards requests to the orchestrator.
func NewEventsHandler(client *http.Client, orchestratorURL string, heartbeat time.Duration) *EventsHandler {
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
	}
}

// RegisterEventRoutes wires the /events endpoint into the provided mux.
func RegisterEventRoutes(mux *http.ServeMux) {
	orchestratorURL := getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000")
	client, err := getOrchestratorClient()
	if err != nil {
		panic(fmt.Sprintf("failed to configure orchestrator client: %v", err))
	}
	handler := NewEventsHandler(client, orchestratorURL, 0)
	mux.Handle("/events", handler)
}

// ServeHTTP implements http.Handler for the EventsHandler.
func (h *EventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	planID := r.URL.Query().Get("plan_id")
	if planID == "" {
		http.Error(w, "plan_id is required", http.StatusBadRequest)
		return
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
