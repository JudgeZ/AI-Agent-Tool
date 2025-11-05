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

func clientIP(r *http.Request) string {
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && ip != "" {
		return ip
	}
	return r.RemoteAddr
}

func auditRequestAttrs(r *http.Request) []slog.Attr {
	attrs := []slog.Attr{slog.String("client_ip", clientIP(r))}
	if requestID := r.Header.Get("X-Request-Id"); requestID != "" {
		attrs = append(attrs, slog.String("request_id", requestID))
	}
	return attrs
}
