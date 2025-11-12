package gateway

import (
	"net"
	"net/http"
	"strings"

	"github.com/JudgeZ/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

var gatewayAuditLogger = audit.Default()

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

func hashedActorFromRequest(r *http.Request, trustedProxies []*net.IPNet, extra ...string) string {
	identityParts := append([]string{clientIP(r, trustedProxies)}, extra...)
	return gatewayAuditLogger.HashIdentity(identityParts...)
}

func auditDetails(base map[string]any) map[string]any {
	return audit.SanitizeDetails(base)
}
