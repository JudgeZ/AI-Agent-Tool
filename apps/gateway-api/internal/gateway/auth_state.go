package gateway

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/securecookie"
)

var stateTTL = GetDurationEnv("OAUTH_STATE_TTL", 10*time.Minute)
var cookieHandler *securecookie.SecureCookie
var cookieHandlerOnce sync.Once
var generateStateAndPKCEFunc = generateStateAndPKCE

func getCookieHandler() *securecookie.SecureCookie {
	cookieHandlerOnce.Do(func() {
		hashKey, err := ResolveEnvValue("GATEWAY_COOKIE_HASH_KEY")
		if err != nil || hashKey == "" {
			hashKey = string(securecookie.GenerateRandomKey(64))
		}

		blockKey, err := ResolveEnvValue("GATEWAY_COOKIE_BLOCK_KEY")
		if err != nil || blockKey == "" {
			blockKey = string(securecookie.GenerateRandomKey(32))
		}

		cookieHandler = securecookie.New([]byte(hashKey), []byte(blockKey))
	})
	return cookieHandler
}

func ResetCookieHandler() {
	cookieHandlerOnce = sync.Once{}
	cookieHandler = nil
}

func setStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecure bool, data stateData) error {
	secureRequest := IsRequestSecure(r, trustedProxies)
	if !secureRequest && !allowInsecure {
		return errors.New("refusing to issue state cookie over insecure request")
	}

	encoded, err := getCookieHandler().Encode(stateCookieName(data.State), data)
	if err != nil {
		return err
	}

	cookie := &http.Cookie{
		Name:     stateCookieName(data.State),
		Value:    encoded,
		Path:     "/auth/",
		Expires:  data.ExpiresAt,
		MaxAge:   int(stateTTL.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}

	if allowInsecure && !secureRequest {
		cookie.Secure = false
	}

	http.SetCookie(w, cookie)
	return nil
}

func readStateCookie(r *http.Request, state string) (stateData, error) {
	cookie, err := r.Cookie(stateCookieName(state))
	if err != nil {
		return stateData{}, err
	}

	var data stateData
	if err := getCookieHandler().Decode(stateCookieName(state), cookie.Value, &data); err != nil {
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

func deleteStateCookie(w http.ResponseWriter, r *http.Request, trustedProxies []*net.IPNet, allowInsecure bool, state string) {
	secureRequest := IsRequestSecure(r, trustedProxies)
	if !secureRequest && !allowInsecure {
		return
	}

	cookie := &http.Cookie{
		Name:     stateCookieName(state),
		Value:    "",
		Path:     "/auth/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}

	if allowInsecure && !secureRequest {
		cookie.Secure = false
	}

	http.SetCookie(w, cookie)
}

func normalizeUpstreamCookies(cookies []*http.Cookie) ([]*http.Cookie, []map[string]any, []map[string]any) {
	if len(cookies) == 0 {
		return []*http.Cookie{}, []map[string]any{}, []map[string]any{}
	}
	normalized := make([]*http.Cookie, 0, len(cookies))
	hardened := make([]map[string]any, 0)
	dropped := make([]map[string]any, 0)

	for _, cookie := range cookies {
		if cookie == nil {
			continue
		}
		if strings.TrimSpace(cookie.Name) == "" {
			dropped = append(dropped, map[string]any{
				"reasons": []string{"missing_name"},
			})
			continue
		}

		clone := *cookie
		enforcements := make([]string, 0, 3)

		if clone.SameSite == http.SameSiteNoneMode {
			dropped = append(dropped, map[string]any{
				"name_hash": gatewayAuditLogger.HashIdentity(cookie.Name),
				"reasons":   []string{"samesite_none_not_allowed"},
			})
			continue
		}

		if !clone.Secure {
			clone.Secure = true
			enforcements = append(enforcements, "secure_enforced")
		}
		if !clone.HttpOnly {
			clone.HttpOnly = true
			enforcements = append(enforcements, "httponly_enforced")
		}
		if clone.SameSite != http.SameSiteStrictMode {
			clone.SameSite = http.SameSiteStrictMode
			enforcements = append(enforcements, "samesite_strict_enforced")
		}

		normalized = append(normalized, &clone)
		if len(enforcements) > 0 {
			hardened = append(hardened, map[string]any{
				"name_hash":    gatewayAuditLogger.HashIdentity(cookie.Name),
				"enforcements": enforcements,
			})
		}
	}

	return normalized, hardened, dropped
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

func stateCookieName(state string) string {
	return fmt.Sprintf("oauth_state_%s", state)
}
