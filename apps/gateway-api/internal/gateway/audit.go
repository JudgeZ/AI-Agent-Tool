package gateway

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
)

var (
	auditLoggerOnce sync.Once
	auditLogger     *slog.Logger
)

func getAuditLogger() *slog.Logger {
	auditLoggerOnce.Do(func() {
		handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
		auditLogger = slog.New(handler).With(slog.String("component", "gateway"), slog.String("category", "audit"))
	})
	return auditLogger
}

func logAudit(ctx context.Context, action, outcome string, attrs ...slog.Attr) {
	logger := getAuditLogger()
	fields := []slog.Attr{
		slog.String("action", action),
		slog.String("result", outcome),
	}
	fields = append(fields, attrs...)
	logger.LogAttrs(ctx, slog.LevelInfo, "audit.event", fields...)
}

func auditRequestAttrs(r *http.Request, trustedProxies []*net.IPNet) []slog.Attr {
	attrs := []slog.Attr{slog.String("client_ip", clientIP(r, trustedProxies))}
	if requestID := r.Header.Get("X-Request-Id"); requestID != "" {
		attrs = append(attrs, slog.String("request_id", requestID))
	}
	return attrs
}

func clientIP(r *http.Request, trustedProxies []*net.IPNet) string {
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	remoteIP := net.ParseIP(host)
	if remoteIP != nil && isTrustedProxy(remoteIP, trustedProxies) {
		if forwarded := extractClientIPFromForwardedFor(r.Header.Get("X-Forwarded-For"), trustedProxies); forwarded != nil {
			return forwarded.String()
		}
		if real := extractClientIP(strings.TrimSpace(r.Header.Get("X-Real-IP")), trustedProxies); real != nil {
			return real.String()
		}
		return remoteIP.String()
	}
	if remoteIP != nil {
		return remoteIP.String()
	}
	return host
}
