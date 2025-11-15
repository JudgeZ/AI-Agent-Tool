package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/OSS-AI-Agent-Tool/OSS-AI-Agent-Tool/apps/gateway-api/internal/audit"
)

const (
	defaultHeartbeatInterval = 30 * time.Second
	heartbeatPayload         = ": ping\n\n"
	auditEventPlanEvents     = "plan.events.subscribe"
	auditTargetPlanEvents    = "plan.events"
	auditCapabilityPlan      = "plan.events"
	// maxAuthorizationHeaderLen allows oversized bearer tokens while bounding resource usage.
	maxAuthorizationHeaderLen = 4096
	// maxLastEventIDHeaderLen comfortably supports UUIDs and vendor specific suffixes.
	maxLastEventIDHeaderLen = 1024
	// maxForwardedCookieHeaderLen caps forwarded cookie headers to 4KiB, matching common browser limits.
	maxForwardedCookieHeaderLen = 4096
)

var forwardedSSEHeaders = []string{
	"X-Agent",
	"X-Request-Id",
	"X-B3-Traceid",
	"X-B3-Spanid",
	"X-B3-Sampled",
	"Traceparent",
	"Tracestate",
}

var planIDPattern = regexp.MustCompile(`(?i)^plan-(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)

func writeUpstreamError(w io.Writer, body []byte) error {
	if len(body) == 0 {
		return nil
	}
	_, err := w.Write(body)
	return err
}

type connectionLimiter struct {
	mu     sync.Mutex
	limit  int
	counts map[string]int
}

func newConnectionLimiter(limit int) *connectionLimiter {
	if limit <= 0 {
		return nil
	}
	return &connectionLimiter{
		limit:  limit,
		counts: make(map[string]int),
	}
}

func (l *connectionLimiter) Acquire(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	current := l.counts[key]
	if current >= l.limit {
		return false
	}
	l.counts[key] = current + 1
	return true
}

func (l *connectionLimiter) Release(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	current, ok := l.counts[key]
	if !ok {
		return
	}
	if current <= 1 {
		delete(l.counts, key)
		return
	}
	l.counts[key] = current - 1
}

// EventRouteConfig captures configuration for the events endpoint wiring.
type EventRouteConfig struct {
	TrustedProxyCIDRs []string
}

// EventsHandler proxies Server-Sent Events streams from the orchestrator.
type EventsHandler struct {
	client            *http.Client
	orchestratorURL   string
	heartbeatInterval time.Duration
	limiter           *connectionLimiter
	trustedProxies    []*net.IPNet
	attemptLimiter    *rateLimiter
	attemptBucket     rateLimitBucket
	auditLogger       *audit.Logger
}

// NewEventsHandler constructs an SSE proxy handler that forwards requests to the orchestrator.
func NewEventsHandler(client *http.Client, orchestratorURL string, heartbeat time.Duration, limiter *connectionLimiter, trustedProxies []*net.IPNet) *EventsHandler {
	if client == nil {
		client = &http.Client{}
	}
	orchestratorURL = strings.TrimRight(orchestratorURL, "/")
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeatInterval
	}
	return &EventsHandler{
		client:            client,
		orchestratorURL:   orchestratorURL,
		heartbeatInterval: heartbeat,
		limiter:           limiter,
		trustedProxies:    trustedProxies,
		auditLogger:       audit.Default(),
	}
}

// RegisterEventRoutes wires the /events endpoint into the provided mux.
func RegisterEventRoutes(mux *http.ServeMux, cfg EventRouteConfig) {
	orchestratorURL := getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000")
	client, err := getOrchestratorClient()
	if err != nil {
		panic(fmt.Sprintf("failed to configure orchestrator client: %v", err))
	}
	maxConnections := getIntEnv("GATEWAY_SSE_MAX_CONNECTIONS_PER_IP", 4)
	trustedProxies, err := parseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		panic(fmt.Sprintf("invalid trusted proxy configuration: %v", err))
	}
	handler := NewEventsHandler(client, orchestratorURL, 0, newConnectionLimiter(maxConnections), trustedProxies)
	handler.attemptLimiter = newRateLimiter()
	handler.attemptBucket = rateLimitBucket{
		Endpoint:     "events.connect",
		IdentityType: "ip",
		Limit:        resolveLimit([]string{"GATEWAY_SSE_CONNECT_LIMIT"}, 12),
		Window:       resolveDuration([]string{"GATEWAY_SSE_CONNECT_WINDOW"}, time.Minute),
	}
	mux.Handle("/events", handler)
}

// ServeHTTP implements http.Handler for the EventsHandler.
func (h *EventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	baseCtx := r.Context()
	auditLogger := h.getAuditLogger()
	planID := strings.TrimSpace(r.URL.Query().Get("plan_id"))
	clientAddr := clientIP(r, h.trustedProxies)
	planHash := ""
	clientHash := ""

	if clientAddr != "" {
		clientHash = auditLogger.HashIdentity(clientAddr)
	}

	if planID == "" {
		h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
			"reason":         "missing_plan_id",
			"client_ip_hash": clientHash,
		})
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "plan_id is required", nil)
		return
	}
	if !planIDPattern.MatchString(planID) {
		planHash = auditLogger.HashIdentity(planID)
		h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
			"reason":         "invalid_plan_id",
			"plan_id_hash":   planHash,
			"client_ip_hash": clientHash,
		})
		writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "plan_id is invalid", nil)
		return
	}

	planHash = auditLogger.HashIdentity(planID)

	if h.attemptLimiter != nil && h.attemptBucket.Limit > 0 && h.attemptBucket.Window > 0 {
		identity := clientAddr
		if identity == "" {
			identity = "unknown"
		}
		allowed, retryAfter, err := h.attemptLimiter.Allow(baseCtx, h.attemptBucket, identity)
		if err != nil {
			slog.WarnContext(baseCtx, "gateway.events.rate_limiter_error",
				slog.String("plan_id", planID),
				slog.String("error", err.Error()),
			)
		} else if !allowed {
			h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
				"reason":              "rate_limited",
				"plan_id_hash":        planHash,
				"client_ip_hash":      clientHash,
				"retry_after_seconds": retryAfterToSeconds(retryAfter),
			})
			respondTooManyRequests(w, r, retryAfter)
			return
		}
	}

	if h.limiter != nil {
		if !h.limiter.Acquire(clientAddr) {
			writeErrorResponse(w, r, http.StatusTooManyRequests, "too_many_requests", "too many concurrent event streams", map[string]any{
				"clientIp": clientAddr,
			})
			h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
				"reason":         "concurrent_limit",
				"plan_id_hash":   planHash,
				"client_ip_hash": clientHash,
			})
			return
		}
		defer h.limiter.Release(clientAddr)
	}

	upstreamURL := fmt.Sprintf("%s/plan/%s/events", h.orchestratorURL, url.PathEscape(planID))
	ctx, cancel := context.WithCancel(baseCtx)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		h.recordAudit(baseCtx, auditOutcomeFailure, map[string]any{
			"reason":         "upstream_request_failed",
			"plan_id_hash":   planHash,
			"client_ip_hash": clientHash,
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "failed to create upstream request", nil)
		return
	}

	req.Header.Set("Accept", "text/event-stream")
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		if err := validateAuthorizationHeader(auth); err != nil {
			h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
				"reason":         "invalid_header",
				"header":         "authorization",
				"detail":         err.Error(),
				"plan_id_hash":   planHash,
				"client_ip_hash": clientHash,
			})
			writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "authorization header invalid", nil)
			return
		}
		req.Header.Set("Authorization", auth)
	}
	if lastEventID := strings.TrimSpace(r.Header.Get("Last-Event-ID")); lastEventID != "" {
		if err := validateLastEventIDHeader(lastEventID); err != nil {
			h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
				"reason":         "invalid_header",
				"header":         "last-event-id",
				"detail":         err.Error(),
				"plan_id_hash":   planHash,
				"client_ip_hash": clientHash,
			})
			writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "last-event-id header invalid", nil)
			return
		}
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	if cookies := r.Header.Values("Cookie"); len(cookies) > 0 {
		sanitizedCookies := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			if cookie == "" {
				continue
			}
			if err := validateForwardedCookie(cookie); err != nil {
				h.recordAudit(baseCtx, auditOutcomeDenied, map[string]any{
					"reason":         "invalid_header",
					"header":         "cookie",
					"detail":         err.Error(),
					"plan_id_hash":   planHash,
					"client_ip_hash": clientHash,
				})
				writeErrorResponse(w, r, http.StatusBadRequest, "invalid_request", "cookie header invalid", nil)
				return
			}
			sanitizedCookies = append(sanitizedCookies, cookie)
		}
		for _, cookie := range sanitizedCookies {
			req.Header.Add("Cookie", cookie)
		}
	}
	cloneHeaders(req.Header, r.Header, forwardedSSEHeaders)

	gatewayAddr := localIP(r)
	appendForwardingHeaders(req.Header, r.Header, clientAddr, gatewayAddr)

	logger := slog.Default()

	resp, err := h.client.Do(req)
	if err != nil {
		h.recordAudit(baseCtx, auditOutcomeFailure, map[string]any{
			"reason":         "upstream_unreachable",
			"plan_id_hash":   planHash,
			"client_ip_hash": clientHash,
		})
		writeErrorResponse(w, r, http.StatusBadGateway, "upstream_error", "failed to contact orchestrator", nil)
		return
	}

	var closeOnce sync.Once
	closeBody := func() {
		closeOnce.Do(func() {
			if err := resp.Body.Close(); err != nil {
				logger.WarnContext(ctx, "gateway.events.response_close_failed", slog.String("plan_id", planID), slog.String("error", err.Error()))
			}
		})
	}
	defer closeBody()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		h.recordAudit(baseCtx, auditOutcomeFailure, map[string]any{
			"reason":         "upstream_error",
			"status_code":    resp.StatusCode,
			"plan_id_hash":   planHash,
			"client_ip_hash": clientHash,
		})
		if len(body) == 0 {
			writeErrorResponse(w, r, resp.StatusCode, "upstream_error", http.StatusText(resp.StatusCode), nil)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		if err := writeUpstreamError(w, body); err != nil {
			logger.WarnContext(ctx, "gateway.events.error_template_render", slog.String("plan_id", planID), slog.String("error", err.Error()))
		}
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.recordAudit(baseCtx, auditOutcomeFailure, map[string]any{
			"reason":         "streaming_unsupported",
			"plan_id_hash":   planHash,
			"client_ip_hash": clientHash,
		})
		writeErrorResponse(w, r, http.StatusInternalServerError, "internal_server_error", "streaming unsupported", nil)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	if accel := resp.Header.Get("X-Accel-Buffering"); accel != "" {
		w.Header().Set("X-Accel-Buffering", accel)
	} else {
		w.Header().Set("X-Accel-Buffering", "no")
	}
	flusher.Flush()

	h.recordAudit(baseCtx, auditOutcomeSuccess, map[string]any{
		"plan_id_hash":   planHash,
		"client_ip_hash": clientHash,
		"status_code":    resp.StatusCode,
	})

	writer := &flushingWriter{w: w, flusher: flusher}
	errCh := make(chan error, 1)

	go func() {
		_, err := io.Copy(writer, resp.Body)
		errCh <- err
	}()

	ticker := time.NewTicker(h.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			closeBody()
			<-errCh
			return
		case err := <-errCh:
			closeBody()
			if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
				if ctx.Err() == nil {
					logger.ErrorContext(ctx, "gateway.events.upstream_error",
						slog.String("plan_id", planID),
						slog.String("error", err.Error()),
					)
					h.recordAudit(baseCtx, auditOutcomeFailure, map[string]any{
						"reason":         "stream_error",
						"plan_id_hash":   planHash,
						"client_ip_hash": clientHash,
						"error":          err.Error(),
					})
					if writeErr := emitSSEErrorEvent(writer, err); writeErr != nil && !errors.Is(writeErr, context.Canceled) && !errors.Is(writeErr, io.EOF) {
						logger.WarnContext(ctx, "gateway.events.error_event_failed",
							slog.String("plan_id", planID),
							slog.String("error", writeErr.Error()),
						)
					}
				}
			}
			return
		case <-ticker.C:
			if _, err := writer.Write([]byte(heartbeatPayload)); err != nil {
				closeBody()
				<-errCh
				return
			}
		}
	}
}

func (h *EventsHandler) getAuditLogger() *audit.Logger {
	if h.auditLogger == nil {
		h.auditLogger = audit.Default()
	}
	return h.auditLogger
}

func validateAuthorizationHeader(value string) error {
	if len(value) > maxAuthorizationHeaderLen {
		return fmt.Errorf("value exceeds %d bytes", maxAuthorizationHeaderLen)
	}
	if hasUnsafeHeaderRunes(value) {
		return errors.New("value contains invalid characters")
	}
	return nil
}

func validateLastEventIDHeader(value string) error {
	if len(value) > maxLastEventIDHeaderLen {
		return fmt.Errorf("value exceeds %d bytes", maxLastEventIDHeaderLen)
	}
	if hasUnsafeHeaderRunes(value) {
		return errors.New("value contains invalid characters")
	}
	return nil
}

func validateForwardedCookie(value string) error {
	if len(value) > maxForwardedCookieHeaderLen {
		return fmt.Errorf("value exceeds %d bytes", maxForwardedCookieHeaderLen)
	}
	if hasUnsafeHeaderRunes(value) {
		return errors.New("value contains invalid characters")
	}
	return nil
}

func hasUnsafeHeaderRunes(value string) bool {
	for _, r := range value {
		if r == '\r' || r == '\n' {
			return true
		}
		if r < 0x20 || r == 0x7f || r > 0x7e {
			return true
		}
	}
	return false
}

func (h *EventsHandler) recordAudit(ctx context.Context, outcome string, details map[string]any) {
	logger := h.getAuditLogger()
	event := audit.Event{
		Name:       auditEventPlanEvents,
		Outcome:    outcome,
		Target:     auditTargetPlanEvents,
		Capability: auditCapabilityPlan,
		Details:    audit.SanitizeDetails(details),
	}
	switch outcome {
	case auditOutcomeSuccess:
		logger.Info(ctx, event)
	case auditOutcomeDenied:
		logger.Security(ctx, event)
	default:
		logger.Error(ctx, event)
	}
}

func retryAfterToSeconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	seconds := int((d + time.Second - 1) / time.Second)
	if seconds < 0 {
		return 0
	}
	return seconds
}

func emitSSEErrorEvent(w io.Writer, upstreamErr error) error {
	if upstreamErr == nil {
		return nil
	}
	message := sanitizeSSEData(upstreamErr.Error())
	payload := fmt.Sprintf("event: error\ndata: %s\n\n", message)
	_, err := w.Write([]byte(payload))
	return err
}

func sanitizeSSEData(data string) string {
	sanitized := strings.ReplaceAll(data, "\r", " ")
	sanitized = strings.ReplaceAll(sanitized, "\n", " ")
	sanitized = strings.TrimSpace(sanitized)
	if sanitized == "" {
		sanitized = "stream interrupted"
	}
	return sanitized
}

type flushingWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
	mu      sync.Mutex
}

func (fw *flushingWriter) Write(p []byte) (int, error) {
	fw.mu.Lock()
	defer fw.mu.Unlock()
	n, err := fw.w.Write(p)
	if n > 0 {
		fw.flusher.Flush()
	}
	return n, err
}

func extractClientIPFromForwardedFor(header string, trustedProxies []*net.IPNet) net.IP {
	if header == "" {
		return nil
	}
	parts := strings.Split(header, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" {
			continue
		}
		ip := net.ParseIP(candidate)
		if ip == nil {
			continue
		}
		if !isTrustedProxy(ip, trustedProxies) {
			return ip
		}
	}
	return nil
}

func extractClientIP(candidate string, trustedProxies []*net.IPNet) net.IP {
	if candidate == "" {
		return nil
	}
	ip := net.ParseIP(candidate)
	if ip == nil {
		return nil
	}
	if isTrustedProxy(ip, trustedProxies) {
		return nil
	}
	return ip
}

func isTrustedProxy(ip net.IP, trusted []*net.IPNet) bool {
	if ip == nil {
		return false
	}
	for _, network := range trusted {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseTrustedProxyCIDRs(entries []string) ([]*net.IPNet, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	proxies := make([]*net.IPNet, 0, len(entries))
	for _, entry := range entries {
		token := strings.TrimSpace(entry)
		if token == "" {
			continue
		}
		if strings.Contains(token, "/") {
			_, network, err := net.ParseCIDR(token)
			if err != nil {
				return nil, fmt.Errorf("invalid CIDR %q: %w", token, err)
			}
			proxies = append(proxies, network)
			continue
		}
		ip := net.ParseIP(token)
		if ip == nil {
			return nil, fmt.Errorf("invalid IP %q", token)
		}
		if ipv4 := ip.To4(); ipv4 != nil {
			mask := net.CIDRMask(net.IPv4len*8, net.IPv4len*8)
			proxies = append(proxies, &net.IPNet{IP: ipv4, Mask: mask})
			continue
		}
		mask := net.CIDRMask(net.IPv6len*8, net.IPv6len*8)
		proxies = append(proxies, &net.IPNet{IP: ip, Mask: mask})
	}
	if len(proxies) == 0 {
		return nil, nil
	}
	return proxies, nil
}

// ParseTrustedProxyCIDRs is an exported helper that normalises trusted proxy
// definitions for use by external callers such as the main package.
func ParseTrustedProxyCIDRs(entries []string) ([]*net.IPNet, error) {
	return parseTrustedProxyCIDRs(entries)
}

func getIntEnv(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < 0 {
		return 0
	}
	return value
}

func cloneHeaders(dst, src http.Header, headers []string) {
	if len(headers) == 0 {
		return
	}
	for _, header := range headers {
		values := src.Values(header)
		if len(values) == 0 {
			continue
		}
		dst.Del(header)
		for _, value := range values {
			if value == "" {
				continue
			}
			dst.Add(header, value)
		}
	}
}

func appendForwardingHeaders(dst, src http.Header, clientAddr, gatewayAddr string) {
	forwardedFor := uniqueHeaderValues(src.Values("X-Forwarded-For"))
	forwardedFor = appendAddressIfMissing(forwardedFor, clientAddr)
	forwardedFor = appendAddressIfMissing(forwardedFor, gatewayAddr)
	if len(forwardedFor) > 0 {
		dst.Del("X-Forwarded-For")
		dst.Add("X-Forwarded-For", strings.Join(forwardedFor, ", "))
	}

	realIP := uniqueHeaderValues(src.Values("X-Real-IP"))
	realIP = appendAddressIfMissing(realIP, clientAddr)
	realIP = appendAddressIfMissing(realIP, gatewayAddr)
	if len(realIP) > 0 {
		dst.Del("X-Real-IP")
		for _, value := range realIP {
			dst.Add("X-Real-IP", value)
		}
	}
}

func uniqueHeaderValues(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		parts := strings.Split(value, ",")
		for _, part := range parts {
			token := strings.TrimSpace(part)
			if token == "" {
				continue
			}
			if _, ok := seen[token]; ok {
				continue
			}
			seen[token] = struct{}{}
			normalized = append(normalized, token)
		}
	}
	return normalized
}

func appendAddressIfMissing(values []string, addr string) []string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return values
	}
	for _, existing := range values {
		if existing == addr {
			return values
		}
	}
	return append(values, addr)
}

func localIP(r *http.Request) string {
	addrVal := r.Context().Value(http.LocalAddrContextKey)
	if addrVal == nil {
		return ""
	}
	netAddr, ok := addrVal.(net.Addr)
	if !ok || netAddr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(netAddr.String())
	if err != nil {
		return strings.TrimSpace(netAddr.String())
	}
	return strings.TrimSpace(host)
}
