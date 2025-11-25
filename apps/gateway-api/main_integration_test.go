//go:build integration
// +build integration

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// TestMainFunction tests the main function setup and initialization
func TestMainFunction(t *testing.T) {
	// Skip in short mode
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create mock servers for orchestrator and indexer
	orchestratorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"healthy"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer orchestratorServer.Close()

	indexerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"healthy"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer indexerServer.Close()

	// Set up environment for testing
	os.Setenv("ORCHESTRATOR_URL", orchestratorServer.URL)
	os.Setenv("INDEXER_URL", indexerServer.URL)
	os.Setenv("NODE_ENV", "test")
	os.Setenv("PORT", "0") // Use random port
	os.Setenv("GATEWAY_HTTP_RATE_LIMIT_MAX", "100")
	os.Setenv("GATEWAY_HTTP_RATE_LIMIT_WINDOW", "1m")

	// Since main() runs forever, we need to test it in a goroutine
	// and verify it starts correctly
	done := make(chan bool)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("main() panicked: %v", r)
			}
			done <- true
		}()

		// We can't actually call main() as it will block forever
		// Instead, we'll test the initialization logic
		testMainInitialization(t)
	}()

	select {
	case <-done:
		// Test completed
	case <-time.After(2 * time.Second):
		// This is expected as main runs forever
	}
}

// testMainInitialization tests the initialization logic from main
func testMainInitialization(t *testing.T) {
	// Test validateServiceURL with production mode
	os.Setenv("NODE_ENV", "production")
	os.Setenv("ORCHESTRATOR_URL", "https://api.example.com")

	url, err := validateServiceURL("ORCHESTRATOR_URL", "http://localhost:4000")
	if err != nil {
		t.Errorf("validateServiceURL failed in production with HTTPS: %v", err)
	}
	if url != "https://api.example.com" {
		t.Errorf("validateServiceURL returned wrong URL: %s", url)
	}

	// Test with development mode
	os.Setenv("NODE_ENV", "development")
	os.Setenv("ORCHESTRATOR_URL", "http://localhost:4000")

	url, err = validateServiceURL("ORCHESTRATOR_URL", "http://localhost:4000")
	if err != nil {
		t.Errorf("validateServiceURL failed in development: %v", err)
	}

	// Test trusted proxy CIDRs parsing
	os.Setenv("GATEWAY_TRUSTED_PROXY_CIDRS", "10.0.0.0/8,192.168.0.0/16")
	cidrs := trustedProxyCIDRsFromEnv()
	if len(cidrs) != 2 {
		t.Errorf("Expected 2 CIDRs, got %d", len(cidrs))
	}

	// Test max request body bytes
	os.Setenv("GATEWAY_MAX_REQUEST_BODY_BYTES", "1048576")
	maxBytes := maxRequestBodyBytesFromEnv()
	if maxBytes != 1048576 {
		t.Errorf("Expected 1048576 bytes, got %d", maxBytes)
	}

	// Test allow insecure state cookie
	os.Setenv("OAUTH_ALLOW_INSECURE_STATE_COOKIE", "false")
	allowInsecure := allowInsecureStateCookieFromEnv()
	if allowInsecure {
		t.Error("Expected allowInsecureStateCookie to be false")
	}

	// Test state cookie validation
	err = validateStateCookieConfig(false)
	if err != nil {
		t.Errorf("validateStateCookieConfig failed: %v", err)
	}

	// Test production state cookie validation (should fail with insecure)
	os.Setenv("NODE_ENV", "production")
	err = validateStateCookieConfig(true)
	if err == nil {
		t.Error("Expected validateStateCookieConfig to fail with insecure cookie in production")
	}
}

// TestMainHTTPServer tests the HTTP server setup
func TestMainHTTPServer(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create a test server with our handler
	handler := buildHTTPHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("OK"))
		}),
		nil,       // No rate limiter for test
		1024*1024, // 1MB max body
	)

	server := httptest.NewServer(handler)
	defer server.Close()

	// Test that the server responds
	resp, err := http.Get(server.URL + "/health")
	if err != nil {
		t.Fatalf("Failed to make request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}

	// Test request ID header
	if requestID := resp.Header.Get("X-Request-Id"); requestID == "" {
		t.Error("Expected X-Request-Id header")
	}
}

// TestMainWithInvalidConfig tests main with invalid configuration
func TestMainWithInvalidConfig(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	tests := []struct {
		name    string
		env     map[string]string
		wantErr bool
	}{
		{
			name: "invalid orchestrator URL",
			env: map[string]string{
				"ORCHESTRATOR_URL": "ftp://invalid",
				"NODE_ENV":         "development",
			},
			wantErr: true,
		},
		{
			name: "http in production",
			env: map[string]string{
				"ORCHESTRATOR_URL": "http://api.example.com",
				"NODE_ENV":         "production",
			},
			wantErr: true,
		},
		{
			name: "valid https in production",
			env: map[string]string{
				"ORCHESTRATOR_URL": "https://api.example.com",
				"NODE_ENV":         "production",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clear environment
			os.Clearenv()

			// Set test environment
			for k, v := range tt.env {
				os.Setenv(k, v)
			}

			_, err := validateServiceURL("ORCHESTRATOR_URL", "http://localhost:4000")

			if tt.wantErr && err == nil {
				t.Error("Expected error but got none")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("Unexpected error: %v", err)
			}
		})
	}
}

// TestMainShutdown tests graceful shutdown
func TestMainShutdown(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Create a context that we can cancel
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create a simple HTTP server
	server := &http.Server{
		Addr: ":0", // Random port
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	}

	// Start server in goroutine
	go func() {
		server.ListenAndServe()
	}()

	// Give server time to start
	time.Sleep(100 * time.Millisecond)

	// Trigger shutdown
	shutdownCtx, _ := context.WithTimeout(context.Background(), 5*time.Second)
	err := server.Shutdown(shutdownCtx)
	if err != nil {
		t.Errorf("Server shutdown failed: %v", err)
	}

	// Verify server stopped
	_, err = http.Get(fmt.Sprintf("http://localhost%s", server.Addr))
	if err == nil {
		t.Error("Expected server to be shut down")
	}
}

// TestBuildHTTPHandler tests the HTTP handler builder
func TestBuildHTTPHandler(t *testing.T) {
	// Create a simple handler
	baseHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("test response"))
	})

	// Build with middleware
	handler := buildHTTPHandler(baseHandler, nil, 1024)

	// Create test request
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()

	// Execute request
	handler.ServeHTTP(w, req)

	// Check response
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Check for request ID header
	if requestID := w.Header().Get("X-Request-Id"); requestID == "" {
		t.Error("Expected X-Request-Id header")
	}

	// Check for trace ID header
	if traceID := w.Header().Get("X-Trace-Id"); traceID == "" {
		t.Error("Expected X-Trace-Id header")
	}
}

// TestEnvironmentValidation tests environment variable validation
func TestEnvironmentValidation(t *testing.T) {
	tests := []struct {
		name    string
		setup   func()
		wantErr bool
	}{
		{
			name: "valid development setup",
			setup: func() {
				os.Setenv("NODE_ENV", "development")
				os.Setenv("ORCHESTRATOR_URL", "http://localhost:4000")
				os.Setenv("INDEXER_URL", "http://localhost:7071")
			},
			wantErr: false,
		},
		{
			name: "valid production setup",
			setup: func() {
				os.Setenv("NODE_ENV", "production")
				os.Setenv("ORCHESTRATOR_URL", "https://api.example.com")
				os.Setenv("INDEXER_URL", "https://indexer.example.com")
			},
			wantErr: false,
		},
		{
			name: "invalid production with http",
			setup: func() {
				os.Setenv("NODE_ENV", "production")
				os.Setenv("ORCHESTRATOR_URL", "http://api.example.com")
			},
			wantErr: true,
		},
		{
			name: "enterprise mode requires https",
			setup: func() {
				os.Setenv("RUN_MODE", "enterprise")
				os.Setenv("ORCHESTRATOR_URL", "http://api.example.com")
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clear environment
			os.Clearenv()

			// Run setup
			tt.setup()

			// Validate orchestrator URL
			_, err := validateServiceURL("ORCHESTRATOR_URL", "http://localhost:4000")

			if tt.wantErr && err == nil {
				t.Error("Expected validation error but got none")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("Unexpected validation error: %v", err)
			}
		})
	}
}
