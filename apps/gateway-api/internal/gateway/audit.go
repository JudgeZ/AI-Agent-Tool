package gateway

import (
	"net"
	"net/http"

	"github.com/JudgeZ/AI-Agent-Tool/apps/gateway-api/internal/audit"
)

var gatewayAuditLogger = audit.Default()

func hashedActorFromRequest(r *http.Request, trustedProxies []*net.IPNet, extra ...string) string {
	identityParts := append([]string{ClientIP(r, trustedProxies)}, extra...)
	return gatewayAuditLogger.HashIdentity(identityParts...)
}

func auditDetails(base map[string]any) map[string]any {
	return audit.SanitizeDetails(base)
}
