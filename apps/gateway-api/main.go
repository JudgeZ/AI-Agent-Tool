package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"oss-ai-agent-tool/apps/gateway-api/internal/gateway"
)

func main() {
	mux := http.NewServeMux()
	startTime := time.Now()
	trustedProxyCIDRs := trustedProxyCIDRsFromEnv()
	gateway.RegisterAuthRoutes(mux, gateway.AuthRouteConfig{TrustedProxyCIDRs: trustedProxyCIDRs})
	gateway.RegisterHealthRoutes(mux, startTime)
	gateway.RegisterEventRoutes(mux, gateway.EventRouteConfig{TrustedProxyCIDRs: trustedProxyCIDRs})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
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
