package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/google/uuid"
)

type contextKey string

const (
	actorContextKey     contextKey = "audit.actor"
	requestIDContextKey contextKey = "audit.request_id"
	defaultSalt                    = "gateway"
)

// Event captures the structured details emitted to the audit log.
type Event struct {
	Name       string
	Outcome    string
	Target     string
	Capability string
	ActorID    string
	Details    map[string]any
}

// Logger provides structured helpers for writing audit events.
type Logger struct {
	logger *slog.Logger
	salt   string
}

// Default constructs a Logger backed by the process-wide slog default logger.
// A custom hashing salt may be provided via the GATEWAY_AUDIT_SALT environment
// variable to ensure hash stability across restarts without leaking raw values.
func Default() *Logger {
	salt := strings.TrimSpace(os.Getenv("GATEWAY_AUDIT_SALT"))
	if salt == "" {
		salt = defaultSalt
	}
	return &Logger{logger: slog.Default(), salt: salt}
}

// WithActor records the hashed actor identifier on the request context so the
// middleware and loggers can include it alongside structured events.
func WithActor(ctx context.Context, actor string) context.Context {
	if actor == "" {
		return ctx
	}
	return context.WithValue(ctx, actorContextKey, actor)
}

// Middleware ensures every request has a stable request identifier available in
// the context and mirrored on the response headers. When no identifier is
// provided it generates a UUIDv4.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
		if requestID == "" {
			requestID = uuid.NewString()
			r.Header.Set("X-Request-Id", requestID)
		}

		ctx := context.WithValue(r.Context(), requestIDContextKey, requestID)
		w.Header().Set("X-Request-Id", requestID)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Info records a successful audit event.
func (l *Logger) Info(ctx context.Context, event Event) {
	l.log(ctx, slog.LevelInfo, "gateway.audit.info", event)
}

// Security records a security-relevant audit event.
func (l *Logger) Security(ctx context.Context, event Event) {
	l.log(ctx, slog.LevelWarn, "gateway.audit.security", event)
}

// Error records an audit event that resulted in a failure.
func (l *Logger) Error(ctx context.Context, event Event) {
	l.log(ctx, slog.LevelError, "gateway.audit.error", event)
}

func (l *Logger) log(ctx context.Context, level slog.Level, msg string, event Event) {
	attrs := []slog.Attr{
		slog.String("event", event.Name),
		slog.String("outcome", event.Outcome),
		slog.String("target", event.Target),
	}
	if event.Capability != "" {
		attrs = append(attrs, slog.String("capability", event.Capability))
	}
	if actor := actorFromContext(ctx, event.ActorID); actor != "" {
		attrs = append(attrs, slog.String("actor_id", actor))
	}
	if reqID := RequestID(ctx); reqID != "" {
		attrs = append(attrs, slog.String("request_id", reqID))
	}
	if len(event.Details) > 0 {
		attrs = append(attrs, slog.Any("details", event.Details))
	}

	l.logger.LogAttrs(ctx, level, msg, attrs...)
}

// HashIdentity hashes the provided identity components using SHA-256 with the
// logger's configured salt. Empty components are ignored to maintain stability.
func (l *Logger) HashIdentity(parts ...string) string {
	h := sha256.New()
	h.Write([]byte(l.salt))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		h.Write([]byte("|"))
		h.Write([]byte(trimmed))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func actorFromContext(ctx context.Context, fallback string) string {
	if actor, ok := ctx.Value(actorContextKey).(string); ok && actor != "" {
		return actor
	}
	return fallback
}

// RequestID extracts the request identifier from the context, returning an
// empty string when none is present.
func RequestID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if requestID, ok := ctx.Value(requestIDContextKey).(string); ok {
		return requestID
	}
	return ""
}

// SanitizeDetails ensures detail values are serialisable and redactable by
// copying the provided map and coercing values into a safe format.
func SanitizeDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	sanitized := make(map[string]any, len(details))
	for key, value := range details {
		switch v := value.(type) {
		case nil:
			sanitized[key] = nil
		case fmt.Stringer:
			sanitized[key] = v.String()
		case error:
			sanitized[key] = v.Error()
		case string, bool, int, int32, int64, uint, uint32, uint64, float32, float64, []string, map[string]any:
			sanitized[key] = v
		default:
			sanitized[key] = fmt.Sprintf("%v", v)
		}
	}
	return sanitized
}
