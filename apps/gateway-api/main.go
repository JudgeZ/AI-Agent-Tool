package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/gateway"
	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/observability/tracing"
)

func main() {
	ctx := context.Background()
	shutdownTracing, err := tracing.Init(ctx)
	if err != nil {
		log.Fatalf("failed to initialize tracing: %v", err)
	}
	if shutdownTracing != nil {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := shutdownTracing(shutdownCtx); err != nil {
				log.Printf("failed to shutdown tracing provider: %v", err)
			}
		}()
	}

	mux := http.NewServeMux()
	startTime := time.Now()
	if _, err := validateServiceURL("ORCHESTRATOR_URL", "http://127.0.0.1:4000"); err != nil {
		log.Fatalf("invalid ORCHESTRATOR_URL: %v", err)
	}
	if _, err := validateServiceURL("INDEXER_URL", "http://127.0.0.1:7070"); err != nil {
		log.Fatalf("invalid INDEXER_URL: %v", err)
	}

	trustedProxyCIDRs := trustedProxyCIDRsFromEnv()
	allowInsecureStateCookie := allowInsecureStateCookieFromEnv()
	trustedNetworks, err := gateway.ParseTrustedProxyCIDRs(trustedProxyCIDRs)
	if err != nil {
		log.Fatalf("invalid trusted proxy configuration: %v", err)
	}
	if err := validateStateCookieConfig(allowInsecureStateCookie); err != nil {
		log.Fatalf("oauth state cookie configuration invalid: %v", err)
	}
	if allowInsecureStateCookie {
		log.Printf("warning: OAUTH_ALLOW_INSECURE_STATE_COOKIE enabled; this should only be used for local development")
	}
	gateway.RegisterAuthRoutes(mux, gateway.AuthRouteConfig{
		TrustedProxyCIDRs:        trustedProxyCIDRs,
		AllowInsecureStateCookie: allowInsecureStateCookie,
	})
	gateway.RegisterHealthRoutes(mux, startTime)
	gateway.RegisterEventRoutes(mux, gateway.EventRouteConfig{TrustedProxyCIDRs: trustedProxyCIDRs})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	globalLimiter := gateway.NewGlobalRateLimiter(trustedNetworks)
	maxBodyBytes := maxRequestBodyBytesFromEnv()
	handler := buildHTTPHandler(mux, globalLimiter, maxBodyBytes)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-shutdown
		log.Printf("received %s, initiating shutdown", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
	}()

	log.Printf("gateway-api listening on http://127.0.0.1:%s", port)

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func buildHTTPHandler(base http.Handler, limiter *gateway.GlobalRateLimiter, maxBodyBytes int64) http.Handler {
	handler := http.Handler(base)
	if maxBodyBytes > 0 {
		handler = gateway.RequestBodyLimitMiddleware(handler, maxBodyBytes)
	}
	if limiter != nil {
		handler = limiter.Middleware(handler)
	}
	// Order middlewares so that audit instrumentation always seeds the request
	// identifier before rate limiting decisions are made while security headers
	// remain on all responses, including 429s.
	handler = gateway.SecurityHeadersMiddleware(handler)
	handler = audit.Middleware(handler)
	return otelhttp.NewHandler(handler, "gateway.http.request", otelhttp.WithPublicEndpoint())
}

func trustedProxyCIDRsFromEnv() []string {
	raw := strings.TrimSpace(os.Getenv("GATEWAY_TRUSTED_PROXY_CIDRS"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	cidrs := make([]string, 0, len(parts))
	for _, part := range parts {
		token := strings.TrimSpace(part)
		if token == "" {
			continue
		}
		cidrs = append(cidrs, token)
	}
	if len(cidrs) == 0 {
		return nil
	}
	return cidrs
}

func allowInsecureStateCookieFromEnv() bool {
	value := strings.TrimSpace(os.Getenv("OAUTH_ALLOW_INSECURE_STATE_COOKIE"))
	if value == "" {
		return false
	}
	switch strings.ToLower(value) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func maxRequestBodyBytesFromEnv() int64 {
	value := strings.TrimSpace(os.Getenv("GATEWAY_MAX_REQUEST_BODY_BYTES"))
	if value == "" {
		return gateway.DefaultMaxRequestBodyBytes()
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return gateway.DefaultMaxRequestBodyBytes()
	}
	return parsed
}

func validateStateCookieConfig(allowInsecure bool) error {
	if !allowInsecure {
		return nil
	}

	nodeEnv := strings.ToLower(strings.TrimSpace(os.Getenv("NODE_ENV")))
	runMode := strings.ToLower(strings.TrimSpace(os.Getenv("RUN_MODE")))

	if nodeEnv == "production" || nodeEnv == "prod" {
		return fmt.Errorf("OAUTH_ALLOW_INSECURE_STATE_COOKIE cannot be true when NODE_ENV=%q", nodeEnv)
	}
	if runMode == "enterprise" {
		return fmt.Errorf("OAUTH_ALLOW_INSECURE_STATE_COOKIE cannot be true when RUN_MODE=enterprise")
	}
	return nil
}

func validateServiceURL(key, fallback string) (string, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	usedFallback := false
	if raw == "" {
		raw = fallback
		usedFallback = true
	}
	normalized, err := normalizeServiceURL(raw)
	if err != nil {
		return "", err
	}
	if requireSecureServiceURLs() {
		if !strings.HasPrefix(strings.ToLower(normalized), "https://") {
			return "", fmt.Errorf("%s must use https when NODE_ENV or RUN_MODE indicate production", key)
		}
		if usedFallback && isLoopbackServiceURL(normalized) {
			return "", fmt.Errorf("%s fallback value is not permitted in production", key)
		}
	}
	if normalized != raw {
		if err := os.Setenv(key, normalized); err != nil {
			log.Printf("warning: failed to normalise %s: %v", key, err)
		}
	}
	return normalized, nil
}

func requireSecureServiceURLs() bool {
	nodeEnv := strings.ToLower(strings.TrimSpace(os.Getenv("NODE_ENV")))
	runMode := strings.ToLower(strings.TrimSpace(os.Getenv("RUN_MODE")))
	if nodeEnv == "production" || nodeEnv == "prod" {
		return true
	}
	switch runMode {
	case "production", "prod", "enterprise":
		return true
	}
	return false
}

func isLoopbackServiceURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := parsed.Host
	if host == "" {
		return false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

func normalizeServiceURL(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("url must not be empty")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("failed to parse url: %w", err)
	}
	switch parsed.Scheme {
	case "http", "https":
	default:
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("host is required")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("credentials are not allowed in service URLs")
	}
	if parsed.RawQuery != "" {
		return "", fmt.Errorf("query parameters are not permitted")
	}
	if parsed.Fragment != "" {
		return "", fmt.Errorf("fragments are not permitted")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	parsed.ForceQuery = false
	sanitized := parsed.String()
	sanitized = strings.TrimRight(sanitized, "/")
	if sanitized == "" {
		return "", fmt.Errorf("url must not be empty")
	}
	return sanitized, nil
}
