package gateway

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
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
		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		cookieHeader := strings.TrimSpace(r.Header.Get("Cookie"))

		if authHeader == "" && cookieHeader == "" {
			writeErrorResponse(w, r, http.StatusUnauthorized, "unauthorized", "authentication required", nil)
			return
		}

		if authHeader != "" {
			if len(authHeader) > maxAuthorizationHeaderLen || hasUnsafeHeaderRunes(authHeader) || !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") || strings.TrimSpace(authHeader[7:]) == "" {
				writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "authorization header invalid", nil)
				return
			}
		}

		if cookieHeader != "" {
			if err := validateForwardedCookie(cookieHeader); err != nil {
				writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "cookie header invalid", map[string]any{"reason": err.Error()})
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}
