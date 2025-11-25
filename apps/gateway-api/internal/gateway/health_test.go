package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestFailureResult(t *testing.T) {
	// Test with error message
	start := time.Now()
	result := failureResult(start, "connection timeout")

	assert.Equal(t, "fail", result.Status)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "connection timeout", *result.Error)
	assert.GreaterOrEqual(t, result.LatencyMs, float64(0))

	// Test with different message
	start = time.Now().Add(-100 * time.Millisecond)
	result = failureResult(start, "service unavailable")
	assert.Equal(t, "fail", result.Status)
	assert.NotNil(t, result.Error)
	assert.Equal(t, "service unavailable", *result.Error)
	assert.GreaterOrEqual(t, result.LatencyMs, float64(100))
}

func TestPtr(t *testing.T) {
	// Test with string
	str := "test value"
	strPtr := ptr(str)
	assert.NotNil(t, strPtr)
	assert.Equal(t, "test value", *strPtr)

	// Test with int
	num := 42
	numPtr := ptr(num)
	assert.NotNil(t, numPtr)
	assert.Equal(t, 42, *numPtr)

	// Test with bool
	b := true
	bPtr := ptr(b)
	assert.NotNil(t, bPtr)
	assert.True(t, *bPtr)

	// Test with empty string
	emptyStr := ""
	emptyPtr := ptr(emptyStr)
	assert.NotNil(t, emptyPtr)
	assert.Equal(t, "", *emptyPtr)

	// Test with zero value
	zero := 0
	zeroPtr := ptr(zero)
	assert.NotNil(t, zeroPtr)
	assert.Equal(t, 0, *zeroPtr)
}

func TestRegisterHealthRoutes(t *testing.T) {
	startTime := time.Now()
	mux := http.NewServeMux()

	// Register the health routes
	RegisterHealthRoutes(mux, startTime)

	// Test /healthz endpoint
	t.Run("healthz endpoint", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/healthz", nil)
		rr := httptest.NewRecorder()

		mux.ServeHTTP(rr, req)

		assert.Equal(t, http.StatusOK, rr.Code)
		assert.Contains(t, rr.Header().Get("Content-Type"), "application/json")

		// Verify response body contains expected fields
		body := rr.Body.String()
		assert.Contains(t, body, `"status":"ok"`)
		assert.Contains(t, body, `"uptime_seconds":`)
	})

	// Test /readyz endpoint
	t.Run("readyz endpoint", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/readyz", nil)
		rr := httptest.NewRecorder()

		mux.ServeHTTP(rr, req)

		// Response should be OK or ServiceUnavailable depending on dependencies
		assert.Contains(t, []int{http.StatusOK, http.StatusServiceUnavailable}, rr.Code)
		assert.Contains(t, rr.Header().Get("Content-Type"), "application/json")

		// Verify response body contains expected fields
		body := rr.Body.String()
		assert.Contains(t, body, `"status":`)
		assert.Contains(t, body, `"uptime_seconds":`)
		assert.Contains(t, body, `"details":`)
	})

	// Test non-existent endpoint
	t.Run("non-existent endpoint", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/nonexistent", nil)
		rr := httptest.NewRecorder()

		mux.ServeHTTP(rr, req)

		assert.Equal(t, http.StatusNotFound, rr.Code)
	})
}

func TestCheckOrchestrator(t *testing.T) {
	ctx := context.Background()

	t.Run("with connection error", func(t *testing.T) {
		// Set orchestrator URL to a non-existent server
		t.Setenv("ORCHESTRATOR_URL", "http://localhost:99999/nonexistent")

		// Use a context with timeout to prevent long wait
		ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		defer cancel()

		result := checkOrchestrator(ctx)
		assert.Equal(t, "fail", result.Status)
		assert.NotNil(t, result.Error)
	})
}

func TestCheckIndexer(t *testing.T) {
	ctx := context.Background()

	t.Run("with connection error", func(t *testing.T) {
		// Set indexer URL to a non-existent server
		t.Setenv("INDEXER_URL", "http://localhost:99999/nonexistent")

		// Use a context with timeout to prevent long wait
		ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		defer cancel()

		result := checkIndexer(ctx)
		assert.Equal(t, "fail", result.Status)
		assert.NotNil(t, result.Error)
	})
}

func TestIndexerDefaultPort(t *testing.T) {
	// Verify the default INDEXER_URL uses port 7071 (HTTP port, not gRPC 7070)
	// This ensures health checks target the correct HTTP endpoint
	t.Run("default URL uses HTTP port 7071", func(t *testing.T) {
		// Clear INDEXER_URL to force use of the hardcoded default
		t.Setenv("INDEXER_URL", "")

		// Call checkIndexer which will fail (no server listening)
		// but the error message will reveal which URL it tried to connect to
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()

		result := checkIndexer(ctx)

		// The check will fail, but we verify it attempted the correct default port
		assert.Equal(t, "fail", result.Status)
		assert.NotNil(t, result.Error)
		// Verify the error references port 7071 (HTTP), not 7070 (gRPC)
		assert.Contains(t, *result.Error, "127.0.0.1:7071",
			"checkIndexer should use default HTTP port 7071, not gRPC port 7070")
	})
}
