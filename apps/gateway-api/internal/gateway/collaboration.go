package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"github.com/JudgeZ/AI-Agent-Tool/apps/gateway-api/internal/audit"
)

const (
	auditEventCollaborationConnect = "collaboration.websocket.connect"
	auditTargetCollaboration       = "collaboration.websocket"
	auditCapabilityCollaboration   = "collaboration.websocket"
)

var (
	collaborationIDPattern     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	collaborationFilePathLimit = 4096
)

// RegisterCollaborationRoutes wires the collaboration WebSocket proxy into the gateway mux.
func RegisterCollaborationRoutes(mux *http.ServeMux) {
	orchestratorURL := GetEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000")
	target, err := url.Parse(orchestratorURL)
	if err != nil {
		panic(fmt.Sprintf("invalid orchestrator url: %v", err))
	}
	proxy := newCollaborationProxy(target)
	mux.Handle("/collaboration/ws", collaborationAuthMiddleware(proxy))
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
		writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to contact orchestrator", nil)
	}

	return proxy
}

func collaborationAuthMiddleware(next http.Handler) http.Handler {
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

		recordCollaborationAudit(r.Context(), r, auditOutcomeSuccess, map[string]any{"reason": "authorized"})
		next.ServeHTTP(w, r)
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

	if len(filePath) > collaborationFilePathLimit || strings.Contains(filePath, "\x00") {
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
