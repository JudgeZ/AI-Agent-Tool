package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

const (
	auditEventHTTPRateLimit = "gateway.http.rate_limit"
	auditTargetHTTP         = "gateway.http"
	auditCapabilityHTTP     = "gateway.http"

	defaultGlobalIPWindow = time.Minute
	defaultGlobalIPLimit  = 120
)

type rateLimitEvaluator interface {
	Allow(context.Context, rateLimitBucket, string) (bool, time.Duration, error)
}

type globalRateLimitPolicy struct {
	buckets []rateLimitBucket
}

// GlobalRateLimiter enforces shared rate limits across all gateway HTTP routes.
type GlobalRateLimiter struct {
	limiter rateLimitEvaluator
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
		var ipIdentity string

		for _, bucket := range g.buckets {
			var identity string
			switch bucket.IdentityType {
			case "ip":
				if ipIdentity == "" {
					ipIdentity = ClientIP(r, g.trusted)
					if ipIdentity == "" {
						ipIdentity = "unknown"
					}
				}
				identity = ipIdentity
			case "agent":
				continue
			default:
				continue
			}

			allowed, retryAfter, err := g.limiter.Allow(ctx, bucket, identity)
			if err != nil {
				slog.ErrorContext(ctx, "gateway.http.rate_limiter_error",
					slog.String("endpoint", bucket.Endpoint),
					slog.String("error", err.Error()),
				)
				details := map[string]any{
					"reason":        "rate_limiter_error",
					"endpoint":      bucket.Endpoint,
					"identity_type": bucket.IdentityType,
					"path":          r.URL.Path,
					"method":        r.Method,
				}
				switch bucket.IdentityType {
				case "ip":
					details["identity_hash"] = gatewayAuditLogger.HashIdentity(identity)
				case "agent":
					details["identity_hash"] = gatewayAuditLogger.HashIdentity("agent", identity)
				}
				details["error"] = err.Error()
				auditHTTPRateLimitEvent(ctx, r, g.trusted, details)
				respondRateLimiterUnavailable(w, r)
				return
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
	ipWindow := ResolveDuration([]string{"GATEWAY_HTTP_IP_RATE_LIMIT_WINDOW", "GATEWAY_HTTP_RATE_LIMIT_WINDOW"}, defaultGlobalIPWindow)
	ipLimit := ResolveLimit([]string{"GATEWAY_HTTP_IP_RATE_LIMIT_MAX", "GATEWAY_HTTP_RATE_LIMIT_MAX"}, defaultGlobalIPLimit)
	buckets := []rateLimitBucket{}
	if ipLimit > 0 && ipWindow > 0 {
		buckets = append(buckets, rateLimitBucket{Endpoint: "http_global", IdentityType: "ip", Window: ipWindow, Limit: ipLimit})
	}

	return globalRateLimitPolicy{buckets: buckets}
}

func respondRateLimiterUnavailable(w http.ResponseWriter, r *http.Request) {
	if updated, _ := audit.EnsureRequestID(r, w); updated != nil {
		r = updated
	}
	w.Header().Set("Retry-After", "1")
	writeErrorResponse(w, r, http.StatusServiceUnavailable, "service_unavailable", "rate limiting temporarily unavailable", nil)
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

type rateLimiter struct {
	mu          sync.Mutex
	windows     map[string]rateLimitWindow
	now         func() time.Time
	lastCleanup time.Time
}

type rateLimitWindow struct {
	expires time.Time
	count   int
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{
		windows: make(map[string]rateLimitWindow),
		now:     time.Now,
	}
}

func (r *rateLimiter) Allow(ctx context.Context, bucket rateLimitBucket, identity string) (bool, time.Duration, error) {
	if r == nil {
		return true, 0, nil
	}
	if bucket.Limit <= 0 || bucket.Window <= 0 {
		return true, 0, nil
	}

	key := fmt.Sprintf("%s|%s|%s", bucket.Endpoint, bucket.IdentityType, identity)
	now := r.now()

	r.mu.Lock()
	defer r.mu.Unlock()

	state := r.windows[key]
	if state.expires.IsZero() || now.After(state.expires) {
		state = rateLimitWindow{expires: now.Add(bucket.Window), count: 0}
	}

	if state.count >= bucket.Limit {
		retryAfter := state.expires.Sub(now)
		if retryAfter < 0 {
			retryAfter = 0
		}
		r.windows[key] = state
		return false, retryAfter, nil
	}

	state.count++
	r.windows[key] = state
	r.maybeCleanup(now)
	return true, 0, nil
}

const rateLimiterCleanupInterval = time.Minute

func (r *rateLimiter) maybeCleanup(now time.Time) {
	if r == nil {
		return
	}
	if !r.lastCleanup.IsZero() && now.Sub(r.lastCleanup) < rateLimiterCleanupInterval {
		return
	}
	for key, window := range r.windows {
		if now.After(window.expires) {
			delete(r.windows, key)
		}
	}
	r.lastCleanup = now
}
