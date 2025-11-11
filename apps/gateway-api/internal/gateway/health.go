package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type dependencyResult struct {
	Status    string   `json:"status"`
	LatencyMs float64  `json:"latency_ms,omitempty"`
	Error     *string  `json:"error,omitempty"`
	Details   []string `json:"details,omitempty"`
}

type healthResponse struct {
	Status        string                       `json:"status"`
	UptimeSeconds float64                      `json:"uptime_seconds"`
	Timestamp     time.Time                    `json:"timestamp"`
	Details       map[string]dependencyResult  `json:"details"`
}

const (
	defaultHealthTimeout  = 3 * time.Second
	orchestratorReadyPath = "/readyz"
	indexerHealthPath     = "/healthz"
)

var (
	indexerClient     = &http.Client{Timeout: 5 * time.Second}
	healthDependencies = []string{"gateway-api"}
)

// RegisterHealthRoutes registers readiness and liveness endpoints for the gateway.
func RegisterHealthRoutes(mux *http.ServeMux, startedAt time.Time) {
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		resp := buildHealthResponse(r.Context(), startedAt, false)
		writeHealthResponse(w, http.StatusOK, resp)
	})

	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		resp := buildHealthResponse(r.Context(), startedAt, true)
		status := http.StatusOK
		if resp.Status != "ok" {
			status = http.StatusServiceUnavailable
		}
		writeHealthResponse(w, status, resp)
	})
}

func buildHealthResponse(ctx context.Context, startedAt time.Time, includeDependencies bool) healthResponse {
	details := make(map[string]dependencyResult)
	for _, name := range healthDependencies {
		details[name] = dependencyResult{Status: "pass"}
	}

	status := "ok"
	if includeDependencies {
		depCtx, cancel := context.WithTimeout(ctx, defaultHealthTimeout)
		defer cancel()

		orchestratorResult := checkOrchestrator(depCtx)
		details["orchestrator"] = orchestratorResult
		if orchestratorResult.Status != "pass" {
			status = "degraded"
		}

		indexerResult := checkIndexer(depCtx)
		details["indexer"] = indexerResult
		if indexerResult.Status != "pass" {
			status = "degraded"
		}
	}

	return healthResponse{
		Status:        status,
		UptimeSeconds: time.Since(startedAt).Seconds(),
		Timestamp:     time.Now().UTC(),
		Details:       details,
	}
}

func writeHealthResponse(w http.ResponseWriter, status int, resp healthResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	_ = encoder.Encode(resp)
}

func checkOrchestrator(ctx context.Context) dependencyResult {
	start := time.Now()
	client, err := getOrchestratorClient()
	if err != nil {
		return failureResult(start, fmt.Sprintf("orchestrator client unavailable: %v", err))
	}

	baseURL := strings.TrimRight(getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000"), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+orchestratorReadyPath, nil)
	if err != nil {
		return failureResult(start, fmt.Sprintf("failed to create orchestrator request: %v", err))
	}

	resp, err := client.Do(req)
	if err != nil {
		return failureResult(start, fmt.Sprintf("orchestrator request failed: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return failureResult(start, fmt.Sprintf("orchestrator readiness returned %d", resp.StatusCode))
	}

	return successResult(start)
}

func checkIndexer(ctx context.Context) dependencyResult {
	start := time.Now()
	baseURL := strings.TrimRight(getEnv("INDEXER_URL", "http://127.0.0.1:7070"), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+indexerHealthPath, nil)
	if err != nil {
		return failureResult(start, fmt.Sprintf("failed to create indexer request: %v", err))
	}

	resp, err := indexerClient.Do(req)
	if err != nil {
		return failureResult(start, fmt.Sprintf("indexer request failed: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return failureResult(start, fmt.Sprintf("indexer health returned %d", resp.StatusCode))
	}

	return successResult(start)
}

func successResult(start time.Time) dependencyResult {
	return dependencyResult{
		Status:    "pass",
		LatencyMs: float64(time.Since(start).Milliseconds()),
	}
}

func failureResult(start time.Time, message string) dependencyResult {
	return dependencyResult{
		Status:    "fail",
		LatencyMs: float64(time.Since(start).Milliseconds()),
		Error:     ptr(message),
	}
}

func ptr[T any](value T) *T {
	return &value
}
