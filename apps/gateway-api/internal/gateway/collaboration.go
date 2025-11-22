package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/JudgeZ/AI-Agent-Tool/apps/gateway-api/internal/audit"
	"go.opentelemetry.io/otel"
)

const (
	auditEventCollaborationConnect = "collaboration.websocket.connect"
	auditTargetCollaboration       = "collaboration.websocket"
	auditCapabilityCollaboration   = "collaboration.websocket"
)

var (
	collaborationIDPattern                      = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	collaborationFilePathLimit                  = 4096
	collaborationTracer                         = otel.Tracer("gateway.collaboration")
	collaborationSessionMaxBodyBytes      int64 = 1 << 20
	defaultCollaborationAuthFailureLimit        = 8
	defaultCollaborationAuthFailureWindow       = time.Minute
)

// CollaborationRouteConfig captures configuration for the collaboration proxy wiring.
type CollaborationRouteConfig struct {
	TrustedProxyCIDRs []string
}

// RegisterCollaborationRoutes wires the collaboration WebSocket proxy into the gateway mux.
func RegisterCollaborationRoutes(mux *http.ServeMux, cfg CollaborationRouteConfig) {
	orchestratorURL := GetEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000")
	target, err := url.Parse(orchestratorURL)
	if err != nil {
		panic(fmt.Sprintf("invalid orchestrator url: %v", err))
	}
	proxy := newCollaborationProxy(target)
	validator := newCollaborationSessionValidator(orchestratorURL)

	trustedProxies, err := ParseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		panic(fmt.Sprintf("invalid trusted proxy configuration: %v", err))
	}

	maxConnections := GetIntEnv("GATEWAY_COLLAB_MAX_CONNECTIONS_PER_IP", 12)
	limiter := newConnectionLimiter(maxConnections)

	authFailureLimiter := newRateLimiter()
	authFailureBucket := rateLimitBucket{
		Endpoint:     "collaboration.auth_failure",
		IdentityType: "ip",
		Limit:        ResolveLimit([]string{"GATEWAY_COLLAB_AUTH_FAILURE_LIMIT"}, defaultCollaborationAuthFailureLimit),
		Window:       ResolveDuration([]string{"GATEWAY_COLLAB_AUTH_FAILURE_WINDOW"}, defaultCollaborationAuthFailureWindow),
	}

	mux.Handle("/collaboration/ws", collaborationConnectionLimiter(trustedProxies, limiter, collaborationAuthMiddleware(validator, authFailureLimiter, authFailureBucket, trustedProxies, proxy)))
}

type collaborationSession struct {
	ID       string  `json:"id"`
	TenantID *string `json:"tenantId"`
}

func newCollaborationSessionValidator(orchestratorURL string) func(context.Context, string, string, string) (collaborationSession, int, error) {
	return func(ctx context.Context, authHeader, cookieHeader, requestID string) (collaborationSession, int, error) {
		client, err := getOrchestratorClient()
		if err != nil {
			return collaborationSession{}, http.StatusBadGateway, err
		}

		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/auth/session", strings.TrimRight(orchestratorURL, "/")), nil)
		if err != nil {
			return collaborationSession{}, http.StatusInternalServerError, err
		}
		req.Header.Set("Accept", "application/json")
		if authHeader != "" {
			req.Header.Set("Authorization", authHeader)
		}
		if cookieHeader != "" {
			req.Header.Set("Cookie", cookieHeader)
		}
		if requestID != "" {
			req.Header.Set("X-Request-Id", requestID)
			req.Header.Set("X-Trace-Id", requestID)
		}

		resp, err := client.Do(req)
		if err != nil {
			return collaborationSession{}, http.StatusBadGateway, err
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusUnauthorized {
			return collaborationSession{}, http.StatusUnauthorized, nil
		}
		if resp.StatusCode != http.StatusOK {
			return collaborationSession{}, http.StatusBadGateway, fmt.Errorf("unexpected status %d", resp.StatusCode)
		}

		var payload struct {
			Session collaborationSession `json:"session"`
		}
		limitedBody := io.LimitReader(resp.Body, collaborationSessionMaxBodyBytes)
		if err := json.NewDecoder(limitedBody).Decode(&payload); err != nil {
			return collaborationSession{}, http.StatusBadGateway, err
		}
		if payload.Session.ID == "" {
			return collaborationSession{}, http.StatusUnauthorized, errors.New("missing session id")
		}
		return payload.Session, http.StatusOK, nil
	}
}

func newCollaborationProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	transportClient, err := getOrchestratorClient()
	if err == nil && transportClient != nil {
		proxy.Transport = transportClient.Transport
	}

	proxy.Rewrite = func(pr *httputil.ProxyRequest) {
		pr.SetXForwarded()
		originalQuery := pr.In.URL.RawQuery
		pr.Out.URL.Scheme = target.Scheme
		pr.Out.URL.Host = target.Host
		pr.Out.URL.Path = "/collaboration/ws"
		pr.Out.URL.RawPath = ""
		pr.Out.URL.RawQuery = originalQuery
		pr.Out.Host = target.Host
		if requestID := audit.RequestID(pr.In.Context()); requestID != "" {
			pr.Out.Header.Set("X-Request-Id", requestID)
			pr.Out.Header.Set("X-Trace-Id", requestID)
		}
		if original := pr.In.Header.Get("Sec-WebSocket-Protocol"); original != "" {
			pr.Out.Header.Set("Sec-WebSocket-Protocol", original)
		}
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.WarnContext(r.Context(), "collaboration proxy error", slog.Any("error", err))
		writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to contact orchestrator", nil)
	}

	return proxy
}

func collaborationAuthMiddleware(
	validate func(context.Context, string, string, string) (collaborationSession, int, error),
	failureLimiter *rateLimiter,
	failureBucket rateLimitBucket,
	trustedProxies []*net.IPNet,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if updated, _ := audit.EnsureRequestID(r, w); updated != nil {
			r = updated
		}

		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		cookieHeader := strings.TrimSpace(r.Header.Get("Cookie"))

		tenantID, projectID, sessionID, filePath, err := parseCollaborationIdentity(r)
		if err != nil {
			if handleCollaborationAuthFailure(r.Context(), w, r, failureLimiter, failureBucket, trustedProxies, "invalid_identity", http.StatusUnauthorized, "unauthorized", "authentication required", map[string]any{"error": err.Error()}, map[string]any{"reason": err.Error()}) {
				return
			}
		}

		q := r.URL.Query()
		q.Set("filePath", filePath)
		r.URL.RawQuery = q.Encode()

		if authHeader == "" && cookieHeader == "" {
			if handleCollaborationAuthFailure(r.Context(), w, r, failureLimiter, failureBucket, trustedProxies, "missing_auth", http.StatusUnauthorized, "unauthorized", "authentication required", nil, nil) {
				return
			}
		}

		if authHeader != "" {
			if len(authHeader) > maxAuthorizationHeaderLen || hasUnsafeHeaderRunes(authHeader) || !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") || strings.TrimSpace(authHeader[7:]) == "" {
				if handleCollaborationAuthFailure(r.Context(), w, r, failureLimiter, failureBucket, trustedProxies, "invalid_authorization_header", http.StatusBadRequest, "invalid_request", "authorization header invalid", nil, nil) {
					return
				}
			}
		}

		if cookieHeader != "" {
			if err := validateForwardedCookie(cookieHeader); err != nil {
				auditDetails := map[string]any{"error": err.Error()}
				if handleCollaborationAuthFailure(r.Context(), w, r, failureLimiter, failureBucket, trustedProxies, "invalid_cookie", http.StatusBadRequest, "invalid_request", "cookie header invalid", auditDetails, map[string]any{"reason": err.Error()}) {
					return
				}
			}
		}

		ctx, span := collaborationTracer.Start(r.Context(), "collaboration.validate_session")
		defer span.End()

		session, status, err := validate(ctx, authHeader, cookieHeader, audit.RequestID(ctx))
		if err != nil {
			recordCollaborationAudit(ctx, r, auditOutcomeFailure, map[string]any{"reason": "session_validation_failed", "error": err.Error()})
			writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to validate session", nil)
			return
		}
		if status != http.StatusOK {
			if handleCollaborationAuthFailure(ctx, w, r, failureLimiter, failureBucket, trustedProxies, "invalid_session", status, "unauthorized", "session validation failed", nil, nil) {
				return
			}
		}
		if sessionID != "" && session.ID != "" && session.ID != sessionID {
			if handleCollaborationAuthFailure(ctx, w, r, failureLimiter, failureBucket, trustedProxies, "session_mismatch", http.StatusForbidden, "forbidden", "session mismatch", nil, nil) {
				return
			}
		}
		if session.TenantID != nil && tenantID != "" && *session.TenantID != tenantID {
			if handleCollaborationAuthFailure(ctx, w, r, failureLimiter, failureBucket, trustedProxies, "tenant_mismatch", http.StatusForbidden, "forbidden", "tenant mismatch", map[string]any{"session_tenant_hash": gatewayAuditLogger.HashIdentity("tenant", *session.TenantID)}, nil) {
				return
			}
		}

		if sessionID == "" {
			sessionID = session.ID
		}
		if tenantID == "" && session.TenantID != nil {
			tenantID = *session.TenantID
		}

		if tenantID == "" || projectID == "" || sessionID == "" {
			if handleCollaborationAuthFailure(ctx, w, r, failureLimiter, failureBucket, trustedProxies, "missing_identity", http.StatusUnauthorized, "unauthorized", "authentication required", nil, nil) {
				return
			}
		}

		if sessionID != "" {
			r.Header.Set("X-Session-Id", sessionID)
		}
		if tenantID != "" {
			r.Header.Set("X-Tenant-Id", tenantID)
		}
		r.Header.Set("X-Project-Id", projectID)

		recordCollaborationAudit(r.Context(), r, auditOutcomeSuccess, map[string]any{"reason": "authorized"})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func handleCollaborationAuthFailure(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	limiter *rateLimiter,
	bucket rateLimitBucket,
	trusted []*net.IPNet,
	reason string,
	status int,
	code string,
	message string,
	auditDetails map[string]any,
	responseDetails map[string]any,
) bool {
	limited, retryAfter, identity := registerCollaborationAuthFailure(ctx, r, limiter, bucket, trusted)
	if limited {
		recordCollaborationAudit(ctx, r, auditOutcomeDenied, map[string]any{
			"reason":                  "auth_rate_limited",
			"client_ip_hash":          gatewayAuditLogger.HashIdentity(identity),
			"retry_after_seconds":     retryAfterToSeconds(retryAfter),
			"original_failure_reason": reason,
		})
		respondTooManyRequests(w, r, retryAfter)
		return true
	}

	mergedAudit := map[string]any{"reason": reason}
	for k, v := range auditDetails {
		mergedAudit[k] = v
	}
	recordCollaborationAudit(ctx, r, auditOutcomeDenied, mergedAudit)
	writeErrorResponse(w, r, status, code, message, responseDetails)
	return true
}

func parseCollaborationIdentity(r *http.Request) (string, string, string, string, error) {
	filePath := strings.TrimSpace(r.URL.Query().Get("filePath"))
	if filePath == "" {
		return "", "", "", "", errors.New("missing file path")
	}
	if len(filePath) > collaborationFilePathLimit || strings.Contains(filePath, "\x00") || strings.HasPrefix(filePath, "/") || strings.Contains(filePath, "..") {
		return "", "", "", "", errors.New("invalid file path")
	}

	tenantID := strings.TrimSpace(r.Header.Get("X-Tenant-Id"))
	if tenantID == "" {
		tenantID = strings.TrimSpace(r.URL.Query().Get("tenantId"))
	}
	if tenantID != "" {
		normalizedTenant, err := normalizeTenantID(tenantID)
		if err != nil || normalizedTenant == "" {
			return "", "", "", "", errors.New("invalid tenant id")
		}
		tenantID = normalizedTenant
	}

	projectID := strings.TrimSpace(r.Header.Get("X-Project-Id"))
	if projectID == "" {
		projectID = strings.TrimSpace(r.URL.Query().Get("projectId"))
	}
	if projectID != "" && !collaborationIDPattern.MatchString(projectID) {
		return "", "", "", "", errors.New("invalid project id")
	}

	sessionID := strings.TrimSpace(r.Header.Get("X-Session-Id"))
	if sessionID == "" {
		sessionID = strings.TrimSpace(r.URL.Query().Get("sessionId"))
	}
	if sessionID != "" && !collaborationIDPattern.MatchString(sessionID) {
		return "", "", "", "", errors.New("invalid session id")
	}

	return tenantID, projectID, sessionID, filePath, nil
}

func recordCollaborationAudit(ctx context.Context, r *http.Request, outcome string, details map[string]any) {
	actor := hashedActorFromRequest(r, nil)
	ctx = audit.WithActor(ctx, actor)
	if details == nil {
		details = map[string]any{}
	}
	details["path"] = r.URL.Path
	if tenant := strings.TrimSpace(r.Header.Get("X-Tenant-Id")); tenant != "" {
		details["tenant_id_hash"] = gatewayAuditLogger.HashIdentity("tenant", tenant)
	}
	if project := strings.TrimSpace(r.Header.Get("X-Project-Id")); project != "" {
		details["project_id_hash"] = gatewayAuditLogger.HashIdentity("project", project)
	}
	if session := strings.TrimSpace(r.Header.Get("X-Session-Id")); session != "" {
		details["session_id_hash"] = gatewayAuditLogger.HashIdentity("session", session)
	}

	event := audit.Event{
		Name:       auditEventCollaborationConnect,
		Outcome:    outcome,
		Target:     auditTargetCollaboration,
		Capability: auditCapabilityCollaboration,
		ActorID:    actor,
		Details:    auditDetails(details),
	}

	switch outcome {
	case auditOutcomeSuccess:
		gatewayAuditLogger.Info(ctx, event)
	default:
		gatewayAuditLogger.Security(ctx, event)
	}

	if reqID := audit.RequestID(ctx); reqID != "" {
		slog.DebugContext(ctx, "collaboration.websocket.audit", slog.String("request_id", reqID), slog.Any("details", event.Details))
	}
}

func collaborationConnectionLimiter(trusted []*net.IPNet, limiter *connectionLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r, trusted)
		if !limiter.Acquire(ip) {
			recordCollaborationAudit(r.Context(), r, auditOutcomeDenied, map[string]any{"reason": "ip_rate_limited", "ip": gatewayAuditLogger.HashIdentity(ip)})
			writeErrorResponse(w, r, http.StatusTooManyRequests, "rate_limited", "too many connections", map[string]any{"retry_after": 60})
			return
		}

		released := sync.Once{}
		release := func() {
			released.Do(func() {
				limiter.Release(ip)
			})
		}

		done := make(chan struct{})
		ctx := r.Context()
		go func() {
			select {
			case <-ctx.Done():
				release()
			case <-done:
			}
		}()

		defer func() {
			close(done)
			release()
		}()
		next.ServeHTTP(w, r)
	})
}

func registerCollaborationAuthFailure(ctx context.Context, r *http.Request, limiter *rateLimiter, bucket rateLimitBucket, trusted []*net.IPNet) (bool, time.Duration, string) {
	identity := ClientIP(r, trusted)
	if identity == "" {
		identity = "unknown"
	}

	if limiter == nil || bucket.Limit <= 0 || bucket.Window <= 0 {
		return false, 0, identity
	}

	allowed, retryAfter, err := limiter.Allow(ctx, bucket, identity)
	if err != nil {
		slog.WarnContext(ctx, "gateway.collaboration.auth_rate_limit_error", slog.String("error", err.Error()))
		return false, 0, identity
	}
	if !allowed {
		return true, retryAfter, identity
	}
	return false, 0, identity
}
