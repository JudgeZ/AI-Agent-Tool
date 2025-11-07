package gateway

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
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
	attrs := []slog.Attr{slog.String("client_ip", clientIPFromRequest(r, trustedProxies))}
	if requestID := r.Header.Get("X-Request-Id"); requestID != "" {
		attrs = append(attrs, slog.String("request_id", requestID))
	}
	return attrs
}
