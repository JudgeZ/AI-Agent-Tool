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
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var stateTTL = getDurationEnv("OAUTH_STATE_TTL", 10*time.Minute)
var orchestratorTimeout = getDurationEnv("ORCHESTRATOR_CALLBACK_TIMEOUT", 10*time.Second)

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

func getProviderConfig(provider string) (oauthProvider, error) {
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
}

func authorizeHandler(w http.ResponseWriter, r *http.Request) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/authorize")
	cfg, err := getProviderConfig(provider)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	redirectURI := r.URL.Query().Get("redirect_uri")
	if redirectURI == "" {
		http.Error(w, "redirect_uri is required", http.StatusBadRequest)
		return
	}
	if err := validateClientRedirect(redirectURI); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	state, codeVerifier, codeChallenge, err := generateStateAndPKCE()
	if err != nil {
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

	if err := setStateCookie(w, r, data); err != nil {
		http.Error(w, "failed to persist state", http.StatusInternalServerError)
		return
	}

	authURL, err := buildAuthorizeURL(cfg, state, codeChallenge)
	if err != nil {
		http.Error(w, "failed to build authorize url", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, authURL, http.StatusFound)
}

func callbackHandler(w http.ResponseWriter, r *http.Request) {
	provider := strings.TrimPrefix(r.URL.Path, "/auth/")
	provider = strings.TrimSuffix(provider, "/callback")

	cfg, err := getProviderConfig(provider)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if errParam := r.URL.Query().Get("error"); errParam != "" {
		redirectError(w, r, provider, errParam)
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		http.Error(w, "code and state are required", http.StatusBadRequest)
		return
	}

	data, err := readStateCookie(r, state)
	if err != nil || data.Provider != provider {
		http.Error(w, "invalid or expired state", http.StatusBadRequest)
		return
	}

	deleteStateCookie(w, r, state)

	payload := map[string]string{
		"code":          code,
		"code_verifier": data.CodeVerifier,
		"redirect_uri":  cfg.RedirectURI,
	}

	buf, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "failed to encode payload", http.StatusInternalServerError)
		return
	}
	orchestratorURL := strings.TrimRight(getEnv("ORCHESTRATOR_URL", "http://127.0.0.1:4000"), "/")
	endpoint := fmt.Sprintf("%s/auth/%s/callback", orchestratorURL, url.PathEscape(provider))
	ctx, cancel := context.WithTimeout(r.Context(), orchestratorTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(buf))
	if err != nil {
		http.Error(w, "failed to create upstream request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client, clientErr := getOrchestratorClient()
	if clientErr != nil {
		http.Error(w, "orchestrator client not configured", http.StatusInternalServerError)
		return
	}

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "failed to contact orchestrator", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		redirectWithStatus(w, r, data.RedirectURI, data.State, "error", extractErrorMessage(body))
		return
	}

	redirectWithStatus(w, r, data.RedirectURI, data.State, "success", "")
}

func redirectError(w http.ResponseWriter, r *http.Request, _ string, errParam string) {
	state := r.URL.Query().Get("state")
	if state == "" {
		http.Error(w, errParam, http.StatusBadRequest)
		return
	}
	data, err := readStateCookie(r, state)
	if err != nil {
		http.Error(w, errParam, http.StatusBadRequest)
		return
	}
	deleteStateCookie(w, r, state)
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
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" {
		host := strings.Split(u.Host, ":")[0]
		if host == "127.0.0.1" || host == "localhost" {
			return nil
		}
	}
	return errors.New("redirect_uri must be https or loopback")
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func setStateCookie(w http.ResponseWriter, r *http.Request, data stateData) error {
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
		Secure:   isRequestSecure(r),
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

func deleteStateCookie(w http.ResponseWriter, r *http.Request, state string) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName(state),
		Value:    "",
		Path:     "/auth/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   isRequestSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func stateCookieName(state string) string {
	return fmt.Sprintf("oauth_state_%s", state)
}

func isRequestSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto != "" {
		return strings.EqualFold(proto, "https")
	}
	return false
}

func RegisterAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/auth/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/authorize"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, http.MethodGet)
				return
			}
			authorizeHandler(w, r)
		case strings.HasSuffix(r.URL.Path, "/callback"):
			if r.Method != http.MethodGet {
				methodNotAllowed(w, http.MethodGet)
				return
			}
			callbackHandler(w, r)
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
