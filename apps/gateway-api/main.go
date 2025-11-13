package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
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
	trustedProxyCIDRs := trustedProxyCIDRsFromEnv()
	allowInsecureStateCookie := allowInsecureStateCookieFromEnv()
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

	handler := audit.Middleware(mux)
	if limitBytes := maxRequestBodyBytesFromEnv(); limitBytes > 0 {
		handler = gateway.RequestBodyLimitMiddleware(handler, limitBytes)
	}
	handler = gateway.SecurityHeadersMiddleware(handler)
	handler = otelhttp.NewHandler(handler, "gateway.http.request", otelhttp.WithPublicEndpoint())

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
