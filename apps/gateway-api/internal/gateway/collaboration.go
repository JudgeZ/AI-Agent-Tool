package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	collaborationIDPattern     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	collaborationFilePathLimit = 4096
	collaborationTracer        = otel.Tracer("gateway.collaboration")
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

	mux.Handle("/collaboration/ws", collaborationConnectionLimiter(trustedProxies, limiter, collaborationAuthMiddleware(validator, proxy)))
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
		if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
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

	proxy.Director = func(req *http.Request) {
		originalQuery := req.URL.RawQuery
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = "/collaboration/ws"
		req.URL.RawPath = ""
		req.URL.RawQuery = originalQuery
		req.Host = target.Host
		if requestID := audit.RequestID(req.Context()); requestID != "" {
			req.Header.Set("X-Request-Id", requestID)
			req.Header.Set("X-Trace-Id", requestID)
		}
		if original := req.Header.Get("Sec-WebSocket-Protocol"); original != "" {
			req.Header.Set("Sec-WebSocket-Protocol", original)
		}
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.WarnContext(r.Context(), "collaboration proxy error", slog.Any("error", err))
		writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to contact orchestrator", nil)
	}

	return proxy
}

func collaborationAuthMiddleware(validate func(context.Context, string, string, string) (collaborationSession, int, error), next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if updated, _ := audit.EnsureRequestID(r, w); updated != nil {
			r = updated
		}

		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		cookieHeader := strings.TrimSpace(r.Header.Get("Cookie"))

		tenantID, projectID, sessionID, filePath, ok := validateCollaborationIdentity(r)
		if !ok {
			recordCollaborationAudit(r.Context(), r, auditOutcomeDenied, map[string]any{"reason": "missing_identity"})
			writeErrorResponse(w, r, http.StatusUnauthorized, "unauthorized", "authentication required", nil)
			return
		}

		r.Header.Set("X-Tenant-Id", tenantID)
		r.Header.Set("X-Project-Id", projectID)
		r.Header.Set("X-Session-Id", sessionID)
		q := r.URL.Query()
		q.Set("filePath", filePath)
		r.URL.RawQuery = q.Encode()

		if authHeader == "" && cookieHeader == "" {
			recordCollaborationAudit(r.Context(), r, auditOutcomeDenied, map[string]any{"reason": "missing_auth"})
			writeErrorResponse(w, r, http.StatusUnauthorized, "unauthorized", "authentication required", nil)
			return
		}

		if authHeader != "" {
			if len(authHeader) > maxAuthorizationHeaderLen || hasUnsafeHeaderRunes(authHeader) || !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") || strings.TrimSpace(authHeader[7:]) == "" {
				recordCollaborationAudit(r.Context(), r, auditOutcomeDenied, map[string]any{"reason": "invalid_authorization_header"})
				writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "authorization header invalid", nil)
				return
			}
		}

		if cookieHeader != "" {
			if err := validateForwardedCookie(cookieHeader); err != nil {
				recordCollaborationAudit(r.Context(), r, auditOutcomeDenied, map[string]any{"reason": "invalid_cookie", "error": err.Error()})
				writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "cookie header invalid", map[string]any{"reason": err.Error()})
				return
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
			recordCollaborationAudit(ctx, r, auditOutcomeDenied, map[string]any{"reason": "invalid_session"})
			writeErrorResponse(w, r, status, "unauthorized", "session validation failed", nil)
			return
		}
		if session.TenantID != nil && *session.TenantID != tenantID {
			recordCollaborationAudit(ctx, r, auditOutcomeDenied, map[string]any{"reason": "tenant_mismatch", "session_tenant_hash": gatewayAuditLogger.HashIdentity("tenant", *session.TenantID)})
			writeErrorResponse(w, r, http.StatusForbidden, "forbidden", "tenant mismatch", nil)
			return
		}

		recordCollaborationAudit(r.Context(), r, auditOutcomeSuccess, map[string]any{"reason": "authorized"})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func validateCollaborationIdentity(r *http.Request) (string, string, string, string, bool) {
	tenantID := strings.TrimSpace(r.Header.Get("X-Tenant-Id"))
	projectID := strings.TrimSpace(r.Header.Get("X-Project-Id"))
	sessionID := strings.TrimSpace(r.Header.Get("X-Session-Id"))
	filePath := strings.TrimSpace(r.URL.Query().Get("filePath"))

	if tenantID == "" || projectID == "" || sessionID == "" || filePath == "" {
		return "", "", "", "", false
	}

	normalizedTenant, err := normalizeTenantID(tenantID)
	if err != nil || normalizedTenant == "" {
		return "", "", "", "", false
	}

	if !collaborationIDPattern.MatchString(projectID) || !collaborationIDPattern.MatchString(sessionID) {
		return "", "", "", "", false
	}

	if len(filePath) > collaborationFilePathLimit || strings.Contains(filePath, "\x00") || strings.HasPrefix(filePath, "/") || strings.Contains(filePath, "..") {
		return "", "", "", "", false
	}

	return normalizedTenant, projectID, sessionID, filePath, true
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

		go func(ctx context.Context) {
			<-ctx.Done()
			release()
		}(r.Context())

		next.ServeHTTP(w, r)
		release()
	})
}
