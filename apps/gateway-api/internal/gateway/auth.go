package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

var stateTTL = getDurationEnv("OAUTH_STATE_TTL", 10*time.Minute)
var orchestratorTimeout = getDurationEnv("ORCHESTRATOR_CALLBACK_TIMEOUT", 10*time.Second)
var allowedRedirectOrigins = loadAllowedRedirectOrigins()

type oidcDiscovery struct {
	authorizationEndpoint string
}

var oidcDiscoveryCache struct {
	metadata oidcDiscovery
	expires  time.Time
	mu       sync.RWMutex
}

type redirectOrigin struct {
	scheme string
	host   string
	port   string
}

type oauthProvider struct {
	Name         string
	AuthorizeURL string
	RedirectURI  string
	ClientID     string
	Scopes       []string
}

type stateData struct {
	Provider     string
	RedirectURI  string
	CodeVerifier string
	ExpiresAt    time.Time
	State        string
}

// AuthRouteConfig captures configuration for the OAuth routes.
type AuthRouteConfig struct {
	TrustedProxyCIDRs []string
}

func getProviderConfig(provider string) (oauthProvider, error) {
	switch provider {
	case "openrouter", "google":
		redirectBase := strings.TrimRight(getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"), "/")
		configs := map[string]oauthProvider{
			"openrouter": {
				Name:         "openrouter",
				AuthorizeURL: "https://openrouter.ai/oauth/authorize",
				RedirectURI:  fmt.Sprintf("%s/auth/openrouter/callback", redirectBase),
				ClientID:     os.Getenv("OPENROUTER_CLIENT_ID"),
				Scopes:       []string{"offline", "openid", "profile"},
			},
			"google": {
				Name:         "google",
				AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
				RedirectURI:  fmt.Sprintf("%s/auth/google/callback", redirectBase),
				ClientID:     os.Getenv("GOOGLE_OAUTH_CLIENT_ID"),
				Scopes:       []string{"openid", "profile", "email", "https://www.googleapis.com/auth/cloud-platform"},
			},
		}
		cfg, ok := configs[provider]
		if !ok {
			return oauthProvider{}, fmt.Errorf("unknown provider: %s", provider)
		}
		if cfg.ClientID == "" {
			return oauthProvider{}, fmt.Errorf("provider %s is not configured", provider)
		}
		return cfg, nil
	case "oidc":
		return getOidcProvider()
	default:
		return oauthProvider{}, fmt.Errorf("unknown provider: %s", provider)
	}
}

func authorizeHandler(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/authorize")
	baseAttrs := append(auditRequestAttrs(r, trustedProxies), slog.String("provider", provider))
	cfg, err := getProviderConfig(provider)
	if err != nil {
		logAudit(r.Context(), "oauth.authorize", "failure", append(baseAttrs, slog.String("error", err.Error()))...)
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	redirectURI := r.URL.Query().Get("redirect_uri")
	if redirectURI == "" {
		logAudit(r.Context(), "oauth.authorize", "failure", append(baseAttrs, slog.String("error", "redirect_uri is required"))...)
		http.Error(w, "redirect_uri is required", http.StatusBadRequest)
		return
	}
	if err := validateClientRedirect(redirectURI); err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", redirectURI), slog.String("error", err.Error()))
		logAudit(r.Context(), "oauth.authorize", "failure", attrs...)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	state, codeVerifier, codeChallenge, err := generateStateAndPKCE()
	if err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", redirectURI), slog.String("error", "state generation failed"))
		logAudit(r.Context(), "oauth.authorize", "failure", attrs...)
		http.Error(w, "failed to generate state", http.StatusInternalServerError)
		return
	}

	data := stateData{
		Provider:     provider,
		RedirectURI:  redirectURI,
		CodeVerifier: codeVerifier,
		ExpiresAt:    time.Now().Add(stateTTL),
		State:        state,
	}

	if err := setStateCookie(w, r, trustedProxies, data); err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", redirectURI), slog.String("error", "state persistence failed"))
		logAudit(r.Context(), "oauth.authorize", "failure", attrs...)
		http.Error(w, "failed to persist state", http.StatusInternalServerError)
		return
	}

	authURL, err := buildAuthorizeURL(cfg, state, codeChallenge)
	if err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", redirectURI), slog.String("error", "authorize url build failed"))
		logAudit(r.Context(), "oauth.authorize", "failure", attrs...)
		http.Error(w, "failed to build authorize url", http.StatusInternalServerError)
		return
	}

	successAttrs := append(baseAttrs, slog.String("redirect_uri", redirectURI))
	logAudit(r.Context(), "oauth.authorize", "success", successAttrs...)

	http.Redirect(w, r, authURL, http.StatusFound)
}

func callbackHandler(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/callback")
	baseAttrs := append(auditRequestAttrs(r, trustedProxies), slog.String("provider", provider))

	cfg, err := getProviderConfig(provider)
	if err != nil {
		logAudit(r.Context(), "oauth.callback", "failure", append(baseAttrs, slog.String("error", err.Error()))...)
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if errParam := r.URL.Query().Get("error"); errParam != "" {
		redirectError(w, r, trustedProxies, errParam)
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		logAudit(r.Context(), "oauth.callback", "failure", append(baseAttrs, slog.String("error", "code and state are required"))...)
		http.Error(w, "code and state are required", http.StatusBadRequest)
		return
	}

	data, err := readStateCookie(r, state)
	if err != nil || data.Provider != provider {
		attrs := append(baseAttrs, slog.String("state", state), slog.String("error", "invalid or expired state"))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, "invalid or expired state", http.StatusBadRequest)
		return
	}

	deleteStateCookie(w, r, trustedProxies, state)

	payload := map[string]string{
		"code":          code,
		"code_verifier": data.CodeVerifier,
		"redirect_uri":  cfg.RedirectURI,
	}

	buf, err := json.Marshal(payload)
	if err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI), slog.String("error", "payload encoding failed"))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, "failed to encode payload", http.StatusInternalServerError)
		return
	}
	orchestratorURL := strings.TrimRight(getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000"), "/")
	endpoint := fmt.Sprintf("%s/auth/%s/callback", orchestratorURL, url.PathEscape(provider))
	ctx, cancel := context.WithTimeout(r.Context(), orchestratorTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI), slog.String("error", "failed to create upstream request"))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, "failed to create upstream request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client, clientErr := getOrchestratorClient()
	if clientErr != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI), slog.String("error", "orchestrator client misconfigured"))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, "orchestrator client not configured", http.StatusInternalServerError)
		return
	}

	resp, err := client.Do(req)
	if err != nil {
		attrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI), slog.String("error", "failed to contact orchestrator"))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, "failed to contact orchestrator", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		errorMessage := extractErrorMessage(body)
		attrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI), slog.Int("status_code", resp.StatusCode), slog.String("error", errorMessage))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		redirectWithStatus(w, r, data.RedirectURI, data.State, "error", errorMessage)
		return
	}

	for _, cookie := range resp.Cookies() {
		http.SetCookie(w, cookie)
	}

	successAttrs := append(baseAttrs, slog.String("redirect_uri", data.RedirectURI))
	logAudit(r.Context(), "oauth.callback", "success", successAttrs...)

	redirectWithStatus(w, r, data.RedirectURI, data.State, "success", "")
}

func redirectError(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, errParam string) {
	state := r.URL.Query().Get("state")
	if state == "" {
		attrs := append(auditRequestAttrs(r, trustedProxies), slog.String("error", errParam))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, errParam, http.StatusBadRequest)
		return
	}
	data, err := readStateCookie(r, state)
	if err != nil {
		attrs := append(auditRequestAttrs(r, trustedProxies), slog.String("state", state), slog.String("error", errParam))
		logAudit(r.Context(), "oauth.callback", "failure", attrs...)
		http.Error(w, errParam, http.StatusBadRequest)
		return
	}
	deleteStateCookie(w, r, trustedProxies, state)
	attrs := append(auditRequestAttrs(r, trustedProxies), slog.String("state", state), slog.String("redirect_uri", data.RedirectURI), slog.String("error", errParam))
	logAudit(r.Context(), "oauth.callback", "failure", attrs...)
	redirectWithStatus(w, r, data.RedirectURI, data.State, "error", errParam)
}

func redirectWithStatus(w http.ResponseWriter, r *http.Request, redirectURI, state, status, message string) {
	target, err := url.Parse(redirectURI)
	if err != nil {
		http.Error(w, "invalid redirect_uri", http.StatusInternalServerError)
		return
	}
	q := target.Query()
	if state != "" {
		q.Set("state", state)
	}
	q.Set("status", status)
	if status == "error" && message != "" {
		q.Set("error", message)
	}
	target.RawQuery = q.Encode()
	http.Redirect(w, r, target.String(), http.StatusFound)
}

func extractErrorMessage(body []byte) string {
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err == nil {
		if msg, ok := parsed["error"].(string); ok {
			return msg
		}
	}
	return string(body)
}

func generateStateAndPKCE() (string, string, string, error) {
	state, err := randomString(32)
	if err != nil {
		return "", "", "", err
	}
	verifier, err := randomString(64)
	if err != nil {
		return "", "", "", err
	}
	challenge := pkceChallenge(verifier)
	return state, verifier, challenge, nil
}

func randomString(length int) (string, error) {
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func buildAuthorizeURL(cfg oauthProvider, state, codeChallenge string) (string, error) {
	u, err := url.Parse(cfg.AuthorizeURL)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", cfg.RedirectURI)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	if len(cfg.Scopes) > 0 {
		q.Set("scope", strings.Join(cfg.Scopes, " "))
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func validateClientRedirect(redirectURI string) error {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return errors.New("invalid redirect_uri")
	}

	if u.Scheme == "http" {
		host := u.Hostname()
		if host == "127.0.0.1" || host == "localhost" || host == "::1" {
			return nil
		}
	}

	if u.Scheme == "" || u.Host == "" {
		return errors.New("invalid redirect_uri")
	}

	if originAllowed(u) {
		return nil
	}

	return errors.New("redirect_uri must match an allowed origin")
}

func originAllowed(u *url.URL) bool {
	for _, allowed := range allowedRedirectOrigins {
		if allowed.matches(u) {
			return true
		}
	}
	return false
}

func (o redirectOrigin) matches(u *url.URL) bool {
	if !strings.EqualFold(o.scheme, u.Scheme) {
		return false
	}
	if !strings.EqualFold(o.host, u.Hostname()) {
		return false
	}
	return o.port == normalizePort(u)
}

func normalizePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

func loadAllowedRedirectOrigins() []redirectOrigin {
	var origins []redirectOrigin

	seen := make(map[string]struct{})

	allowedList := strings.Split(os.Getenv("OAUTH_ALLOWED_REDIRECT_ORIGINS"), ",")
	for _, entry := range allowedList {
		origin, ok := parseRedirectOrigin(strings.TrimSpace(entry))
		if ok {
			key := originKey(origin)
			if _, exists := seen[key]; !exists {
				origins = append(origins, origin)
				seen[key] = struct{}{}
			}
		}
	}

	if len(origins) == 0 {
		if origin, ok := parseRedirectOrigin(strings.TrimSpace(getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"))); ok {
			key := originKey(origin)
			if _, exists := seen[key]; !exists {
				origins = append(origins, origin)
				seen[key] = struct{}{}
			}
		}
	}

	return origins
}

func parseRedirectOrigin(raw string) (redirectOrigin, bool) {
	if raw == "" {
		return redirectOrigin{}, false
	}

	u, err := url.Parse(raw)
	if err != nil {
		return redirectOrigin{}, false
	}

	host := u.Hostname()
	if host == "" || u.Scheme == "" {
		return redirectOrigin{}, false
	}

	origin := redirectOrigin{
		scheme: strings.ToLower(u.Scheme),
		host:   strings.ToLower(host),
		port:   normalizePort(u),
	}

	if origin.port == "" {
		return redirectOrigin{}, false
	}

	return origin, true
}

func originKey(o redirectOrigin) string {
	return fmt.Sprintf("%s://%s:%s", o.scheme, o.host, o.port)
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func setStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, data stateData) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     stateCookieName(data.State),
		Value:    base64.RawURLEncoding.EncodeToString(encoded),
		Path:     "/auth/",
		Expires:  data.ExpiresAt,
		MaxAge:   int(stateTTL.Seconds()),
		HttpOnly: true,
		Secure:   isRequestSecure(r, trustedProxies),
		// nosemgrep: go.lang.security.audit.net.cookie-missing-secure.cookie-missing-secure -- secure flag depends on TLS or trusted proxies
		SameSite: http.SameSiteLaxMode,
	}

	http.SetCookie(w, cookie)
	return nil
}

func readStateCookie(r *http.Request, state string) (stateData, error) {
	cookie, err := r.Cookie(stateCookieName(state))
	if err != nil {
		return stateData{}, err
	}

	decoded, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil {
		return stateData{}, err
	}

	var data stateData
	if err := json.Unmarshal(decoded, &data); err != nil {
		return stateData{}, err
	}

	if data.State != state {
		return stateData{}, errors.New("state mismatch")
	}

	if time.Now().After(data.ExpiresAt) {
		return stateData{}, errors.New("state expired")
	}

	return data, nil
}

func deleteStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, state string) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName(state),
		Value:    "",
		Path:     "/auth/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isRequestSecure(r, trustedProxies),
		// nosemgrep: go.lang.security.audit.net.cookie-missing-secure.cookie-missing-secure -- secure flag depends on TLS or trusted proxies
		SameSite: http.SameSiteLaxMode,
	})
}

func stateCookieName(state string) string {
	return fmt.Sprintf("oauth_state_%s", state)
}

func isRequestSecure(r *http.Request, trustedProxies []*net.IPNet) bool {
	if r.TLS != nil {
		return true
	}
	proto, ok := forwardedProto(r)
	if !ok {
		return false
	}
	remoteIP := requestRemoteIP(r)
	if !isTrustedProxy(remoteIP, trustedProxies) {
		return false
	}
	return strings.EqualFold(proto, "https")
}

func requestRemoteIP(r *http.Request) net.IP {
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	if host == "" {
		return nil
	}
	return net.ParseIP(host)
}

func forwardedProto(r *http.Request) (string, bool) {
	headers := []string{"X-Forwarded-Proto", "X-Forwarded-Protocol", "X-Url-Scheme"}
	for _, header := range headers {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			return value, true
		}
	}
	if ssl := strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")); ssl != "" {
		if strings.EqualFold(ssl, "on") || ssl == "1" || strings.EqualFold(ssl, "enabled") {
			return "https", true
		}
		return "http", true
	}
	for _, forwarded := range r.Header.Values("Forwarded") {
		directives := strings.Split(forwarded, ";")
		for _, directive := range directives {
			kv := strings.SplitN(strings.TrimSpace(directive), "=", 2)
			if len(kv) != 2 {
				continue
			}
			if strings.EqualFold(kv[0], "proto") {
				value := strings.Trim(strings.TrimSpace(kv[1]), "\"")
				if value != "" {
					return value, true
				}
			}
		}
	}
	return "", false
}

func RegisterAuthRoutes(mux *http.ServeMux, cfg AuthRouteConfig) {
	trustedProxies, err := parseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs)
	if err != nil {
		panic(fmt.Sprintf("invalid trusted proxy configuration: %v", err))
	}

	limiter := newAuthRateLimiter()
	authorize := withAuthRateLimit(authorizeHandler, limiter, trustedProxies)
	callback := withAuthRateLimit(callbackHandler, limiter, trustedProxies)

	mux.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/authorize"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, http.MethodGet)
				return
			}
			authorize(w, r)
		case strings.HasSuffix(r.URL.Path, "/callback"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, http.MethodGet)
				return
			}
			callback(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func getDurationEnv(key string, fallback time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		dur, err := time.ParseDuration(value)
		if err == nil {
			return dur
		}
	}
	return fallback
}

func parseScopeList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		raw = "openid"
	}
	items := strings.FieldsFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r) || r == ','
	})
	set := make(map[string]struct{}, len(items)+1)
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed != "" {
			set[trimmed] = struct{}{}
		}
	}
	set["openid"] = struct{}{}
	result := make([]string, 0, len(set))
	for scope := range set {
		result = append(result, scope)
	}
	sort.Strings(result)
	return result
}

type ipRateLimiter struct {
	window time.Duration
	max    int
	mu     sync.Mutex
	hits   map[string][]time.Time
}

func newAuthRateLimiter() *ipRateLimiter {
	window := getDurationEnv("GATEWAY_AUTH_RATE_LIMIT_WINDOW", time.Minute)
	max := getIntEnv("GATEWAY_AUTH_RATE_LIMIT_MAX", 10)
	if max <= 0 {
		return nil
	}
	if window <= 0 {
		window = time.Minute
	}
	return &ipRateLimiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
	}
}

func withAuthRateLimit(handler func(http.ResponseWriter, *http.Request, []*net.IPNet), limiter *ipRateLimiter, trustedProxies []*net.IPNet) http.HandlerFunc {
	if limiter == nil {
		return func(w http.ResponseWriter, r *http.Request) {
			handler(w, r, trustedProxies)
		}
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, trustedProxies)
		if ip == "" {
			ip = "unknown"
		}
		if !limiter.Allow(ip) {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		handler(w, r, trustedProxies)
	}
}

func (l *ipRateLimiter) Allow(id string) bool {
	now := time.Now()
	cutoff := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := l.hits[id]
	keep := entries[:0]
	for _, ts := range entries {
		if ts.After(cutoff) {
			keep = append(keep, ts)
		}
	}
	if len(keep) >= l.max {
		l.hits[id] = keep
		return false
	}
	keep = append(keep, now)
	l.hits[id] = keep
	return true
}

func loadOidcMetadata(issuer string) (oidcDiscovery, error) {
	trimmed := strings.TrimRight(issuer, "/")
	now := time.Now()
	cache := &oidcDiscoveryCache

	cache.mu.RLock()
	if cache.metadata.authorizationEndpoint != "" && now.Before(cache.expires) {
		metadata := cache.metadata
		cache.mu.RUnlock()
		return metadata, nil
	}
	cache.mu.RUnlock()

	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.metadata.authorizationEndpoint != "" && now.Before(cache.expires) {
		return cache.metadata, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	discoveryURL := fmt.Sprintf("%s/.well-known/openid-configuration", trimmed)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return oidcDiscovery{}, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return oidcDiscovery{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return oidcDiscovery{}, fmt.Errorf("oidc discovery returned %d", resp.StatusCode)
	}

	var payload struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return oidcDiscovery{}, err
	}
	if payload.AuthorizationEndpoint == "" {
		return oidcDiscovery{}, errors.New("oidc discovery missing authorization_endpoint")
	}

	metadata := oidcDiscovery{authorizationEndpoint: payload.AuthorizationEndpoint}
	cache.metadata = metadata
	cache.expires = now.Add(15 * time.Minute)
	return metadata, nil
}

func getOidcProvider() (oauthProvider, error) {
	issuer := strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL"))
	if issuer == "" {
		return oauthProvider{}, fmt.Errorf("oidc issuer not configured")
	}
	clientID := strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID"))
	if clientID == "" {
		return oauthProvider{}, fmt.Errorf("oidc client id not configured")
	}

	metadata, err := loadOidcMetadata(issuer)
	if err != nil {
		return oauthProvider{}, err
	}

	redirectBase := strings.TrimRight(getEnv("OIDC_REDIRECT_BASE", getEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080")), "/")
	if redirectBase == "" {
		redirectBase = "http://127.0.0.1:8080"
	}
	rawScopes := os.Getenv("OIDC_SCOPES")
	if strings.TrimSpace(rawScopes) == "" {
		rawScopes = "openid profile email"
	}
	scopes := parseScopeList(rawScopes)

	return oauthProvider{
		Name:         "oidc",
		AuthorizeURL: metadata.authorizationEndpoint,
		RedirectURI:  fmt.Sprintf("%s/auth/oidc/callback", redirectBase),
		ClientID:     clientID,
		Scopes:       scopes,
	}, nil
}
