package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
	"unicode"
)

func getProviderConfig(provider string) (oauthProvider, error) {
	switch provider {
	case "openrouter", "google":
		redirectBase := strings.TrimRight(GetEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080"), "/")
		openrouterClientID, err := ResolveEnvValue("OPENROUTER_CLIENT_ID")
		if err != nil {
			return oauthProvider{}, fmt.Errorf("failed to load OPENROUTER_CLIENT_ID: %w", err)
		}
		googleClientID, err := ResolveEnvValue("GOOGLE_OAUTH_CLIENT_ID")
		if err != nil {
			return oauthProvider{}, fmt.Errorf("failed to load GOOGLE_OAUTH_CLIENT_ID: %w", err)
		}
		configs := map[string]oauthProvider{
			"openrouter": {
				Name:         "openrouter",
				AuthorizeURL: "https://openrouter.ai/oauth/authorize",
				RedirectURI:  fmt.Sprintf("%s/auth/openrouter/callback", redirectBase),
				ClientID:     openrouterClientID,
				Scopes:       []string{"offline", "openid", "profile"},
			},
			"google": {
				Name:         "google",
				AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
				RedirectURI:  fmt.Sprintf("%s/auth/google/callback", redirectBase),
				ClientID:     googleClientID,
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

func getOidcProvider() (oauthProvider, error) {
	issuer := strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL"))
	if issuer == "" {
		return oauthProvider{}, fmt.Errorf("oidc issuer not configured")
	}
	clientID, err := ResolveEnvValue("OIDC_CLIENT_ID")
	if err != nil {
		return oauthProvider{}, fmt.Errorf("failed to load OIDC_CLIENT_ID: %w", err)
	}
	if clientID == "" {
		return oauthProvider{}, fmt.Errorf("oidc client id not configured")
	}

	metadata, err := loadOidcMetadata(issuer)
	if err != nil {
		return oauthProvider{}, err
	}

	redirectBase := strings.TrimRight(GetEnv("OIDC_REDIRECT_BASE", GetEnv("OAUTH_REDIRECT_BASE", "http://127.0.0.1:8080")), "/")
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

func buildAuthorizeURL(cfg oauthProvider, state, codeChallenge string) (*url.URL, error) {
	u, err := url.Parse(cfg.AuthorizeURL)
	if err != nil {
		return nil, err
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
	return u, nil
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
