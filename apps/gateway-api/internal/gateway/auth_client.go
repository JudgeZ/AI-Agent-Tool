package gateway

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
)

func (r oidcClientRegistration) allowsRedirect(u *url.URL) bool {
	if len(r.RedirectOrigins) == 0 {
		return true
	}
	for _, origin := range r.RedirectOrigins {
		if origin.matches(u) {
			return true
		}
	}
	return false
}

// resetOidcClientRegistrations clears cached registrations for tests.
func resetOidcClientRegistrations() {
	oidcClientRegistrationsMu.Lock()
	defer oidcClientRegistrationsMu.Unlock()
	oidcClientRegistrationsOnce = sync.Once{}
	oidcClientRegistrations = nil
	oidcClientRegistrationsErr = nil
}

func loadOidcClientRegistrations() (map[string]map[string]oidcClientRegistration, error) {
	oidcClientRegistrationsMu.Lock()
	defer oidcClientRegistrationsMu.Unlock()
	oidcClientRegistrationsOnce.Do(func() {
		raw, err := ResolveEnvValue("OIDC_CLIENT_REGISTRATIONS")
		if err != nil {
			oidcClientRegistrationsErr = fmt.Errorf("failed to load OIDC_CLIENT_REGISTRATIONS: %w", err)
			return
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			oidcClientRegistrations = map[string]map[string]oidcClientRegistration{}
			return
		}
		parsed, parseErr := parseOidcClientRegistrations(trimmed)
		if parseErr != nil {
			oidcClientRegistrationsErr = parseErr
			return
		}
		oidcClientRegistrations = parsed
	})
	if oidcClientRegistrationsErr != nil {
		return nil, oidcClientRegistrationsErr
	}
	return oidcClientRegistrations, nil
}

func parseOidcClientRegistrations(raw string) (map[string]map[string]oidcClientRegistration, error) {
	type registrationPayload struct {
		TenantID               string   `json:"tenant_id"`
		AppID                  string   `json:"app"`
		ClientID               string   `json:"client_id"`
		RedirectOrigins        []string `json:"redirect_origins"`
		SessionBindingRequired bool     `json:"session_binding_required"`
	}

	var payload []registrationPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, fmt.Errorf("failed to parse OIDC_CLIENT_REGISTRATIONS: %w", err)
	}

	result := make(map[string]map[string]oidcClientRegistration)
	for idx, entry := range payload {
		tenantID, err := normalizeTenantID(entry.TenantID)
		if err != nil {
			return nil, fmt.Errorf("registration %d: %w", idx, err)
		}
		appID, err := normalizeClientApp(entry.AppID)
		if err != nil {
			return nil, fmt.Errorf("registration %d: %w", idx, err)
		}
		clientID := strings.TrimSpace(entry.ClientID)
		if clientID == "" {
			return nil, fmt.Errorf("registration %d: client_id is required", idx)
		}
		if len(clientID) > maxClientIDLength {
			return nil, fmt.Errorf("registration %d: client_id must be at most %d characters", idx, maxClientIDLength)
		}
		var origins []redirectOrigin
		for _, rawOrigin := range entry.RedirectOrigins {
			origin, ok := parseRedirectOrigin(strings.TrimSpace(rawOrigin))
			if !ok {
				return nil, fmt.Errorf("registration %d: invalid redirect origin %q", idx, rawOrigin)
			}
			origins = append(origins, origin)
		}
		tenantKey := normalizeTenantKey(tenantID)
		if _, ok := result[tenantKey]; !ok {
			result[tenantKey] = make(map[string]oidcClientRegistration)
		}
		reg := oidcClientRegistration{
			TenantID:               tenantID,
			AppID:                  appID,
			ClientID:               clientID,
			RedirectOrigins:        origins,
			SessionBindingRequired: entry.SessionBindingRequired,
		}
		if _, exists := result[tenantKey][appID]; exists {
			return nil, fmt.Errorf("registration %d: duplicate entry for tenant %q and app %q", idx, tenantID, appID)
		}
		result[tenantKey][appID] = reg
	}

	return result, nil
}

func getOidcClientRegistration(tenantID, appID string) (oidcClientRegistration, bool, bool, error) {
	configs, err := loadOidcClientRegistrations()
	if err != nil {
		return oidcClientRegistration{}, false, false, err
	}
	configured := len(configs) > 0
	if !configured {
		return oidcClientRegistration{}, false, false, nil
	}
	tenantKey := normalizeTenantKey(tenantID)
	if regs, ok := configs[tenantKey]; ok {
		if reg, ok := regs[appID]; ok {
			return reg, true, true, nil
		}
	}
	if tenantKey != "" {
		if regs, ok := configs[""]; ok {
			if reg, ok := regs[appID]; ok {
				return reg, true, true, nil
			}
		}
	}
	return oidcClientRegistration{}, false, true, nil
}
