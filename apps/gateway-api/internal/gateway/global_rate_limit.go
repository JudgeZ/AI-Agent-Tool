package gateway

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

const (
	auditEventHTTPRateLimit = "gateway.http.rate_limit"
	auditTargetHTTP         = "gateway.http"
	auditCapabilityHTTP     = "gateway.http"

	defaultGlobalIPWindow    = time.Minute
	defaultGlobalIPLimit     = 120
	defaultGlobalAgentWindow = time.Minute
	defaultGlobalAgentLimit  = 600

	anonymousAgentIdentity = "anonymous"
)

type globalRateLimitPolicy struct {
	buckets []rateLimitBucket
}

// GlobalRateLimiter enforces shared rate limits across all gateway HTTP routes.
type GlobalRateLimiter struct {
	limiter *rateLimiter
	buckets []rateLimitBucket
	trusted []*net.IPNet
}

// NewGlobalRateLimiter constructs a GlobalRateLimiter using environment backed
// configuration for IP and agent limits.
func NewGlobalRateLimiter(trusted []*net.IPNet) *GlobalRateLimiter {
	policy := newGlobalRateLimitPolicy()
	return &GlobalRateLimiter{
		limiter: newRateLimiter(),
		buckets: policy.buckets,
		trusted: trusted,
	}
}

// Middleware wraps the provided handler with global rate limiting. When limits
// are exceeded the middleware returns a 429 response and emits an audit event.
func (g *GlobalRateLimiter) Middleware(next http.Handler) http.Handler {
	if g == nil || g.limiter == nil || len(g.buckets) == 0 {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if updated, _ := audit.EnsureRequestID(r, w); updated != nil {
			r = updated
		}
		ctx := r.Context()
		var (
			ipIdentity    string
			agentIdentity string
		)

		for _, bucket := range g.buckets {
			var identity string
			switch bucket.IdentityType {
			case "ip":
				if ipIdentity == "" {
					ipIdentity = clientIP(r, g.trusted)
					if ipIdentity == "" {
						ipIdentity = "unknown"
					}
				}
				identity = ipIdentity
			case "agent":
				if agentIdentity == "" {
					agentIdentity = sanitizeAgentIdentity(r.Header.Get("X-Agent"))
					if agentIdentity == "" {
						agentIdentity = anonymousAgentIdentity
					}
				}
				identity = agentIdentity
			default:
				continue
			}

			allowed, retryAfter, err := g.limiter.Allow(ctx, bucket, identity)
			if err != nil {
				slog.WarnContext(ctx, "gateway.http.rate_limiter_error",
					slog.String("endpoint", bucket.Endpoint),
					slog.String("error", err.Error()),
				)
				continue
			}
			if !allowed {
				details := map[string]any{
					"reason":              "rate_limited",
					"endpoint":            bucket.Endpoint,
					"identity_type":       bucket.IdentityType,
					"path":                r.URL.Path,
					"method":              r.Method,
					"retry_after_seconds": retryAfterToSeconds(retryAfter),
				}
				switch bucket.IdentityType {
				case "ip":
					details["identity_hash"] = gatewayAuditLogger.HashIdentity(identity)
				case "agent":
					details["identity_hash"] = gatewayAuditLogger.HashIdentity("agent", identity)
				}
				auditHTTPRateLimitEvent(ctx, r, g.trusted, details)
				respondTooManyRequests(w, r, retryAfter)
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func newGlobalRateLimitPolicy() globalRateLimitPolicy {
	ipWindow := resolveDuration([]string{"GATEWAY_HTTP_IP_RATE_LIMIT_WINDOW", "GATEWAY_HTTP_RATE_LIMIT_WINDOW"}, defaultGlobalIPWindow)
	ipLimit := resolveLimit([]string{"GATEWAY_HTTP_IP_RATE_LIMIT_MAX", "GATEWAY_HTTP_RATE_LIMIT_MAX"}, defaultGlobalIPLimit)
	agentWindow := resolveDuration([]string{"GATEWAY_HTTP_AGENT_RATE_LIMIT_WINDOW"}, defaultGlobalAgentWindow)
	agentLimit := resolveLimit([]string{"GATEWAY_HTTP_AGENT_RATE_LIMIT_MAX"}, defaultGlobalAgentLimit)

	buckets := []rateLimitBucket{}
	if ipLimit > 0 && ipWindow > 0 {
		buckets = append(buckets, rateLimitBucket{Endpoint: "http_global", IdentityType: "ip", Window: ipWindow, Limit: ipLimit})
	}
	if agentLimit > 0 && agentWindow > 0 {
		buckets = append(buckets, rateLimitBucket{Endpoint: "http_global", IdentityType: "agent", Window: agentWindow, Limit: agentLimit})
	}

	return globalRateLimitPolicy{buckets: buckets}
}

func sanitizeAgentIdentity(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) > 128 {
		trimmed = trimmed[:128]
	}
	if hasUnsafeHeaderRunes(trimmed) {
		return ""
	}
	return trimmed
}

func auditHTTPRateLimitEvent(ctx context.Context, r *http.Request, trusted []*net.IPNet, details map[string]any) {
	actor := hashedActorFromRequest(r, trusted)
	ctx = audit.WithActor(ctx, actor)
	event := audit.Event{
		Name:       auditEventHTTPRateLimit,
		Outcome:    auditOutcomeDenied,
		Target:     auditTargetHTTP,
		Capability: auditCapabilityHTTP,
		ActorID:    actor,
		Details:    auditDetails(details),
	}
	gatewayAuditLogger.Security(ctx, event)
}
