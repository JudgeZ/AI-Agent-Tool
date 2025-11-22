package gateway

import (
	"sync"
	"time"
)

const (
	auditEventAuthorize   = "auth.oauth.authorize"
	auditEventCallback    = "auth.oauth.callback"
	auditEventRedirectErr = "auth.oauth.redirect"
	auditTargetAuth       = "auth.oauth"
	auditCapabilityAuth   = "auth.public"

	auditOutcomeSuccess = "success"
	auditOutcomeDenied  = "denied"
	auditOutcomeFailure = "failure"

	defaultAuthIPLimit        = 30
	defaultAuthIdentityLimit  = 10
	defaultAuthIPWindow       = time.Minute
	defaultAuthIdentityWindow = time.Minute

	tenantValidationErrorMessage = "tenant_id may only include letters, numbers, '.', '_' or '-'"
	defaultClientApp             = "gui"
	maxSessionBindingLength      = 256
	maxClientIDLength            = 256
)

type validationError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

type authorizeRequestParams struct {
	RedirectURI string `validate:"required,uri,max=2048" json:"redirect_uri"`
	TenantID    string `json:"tenant_id"`
	ClientApp   string `validate:"omitempty,max=64" json:"client_app"`
	BindingID   string `validate:"omitempty,max=256" json:"session_binding"`
}

type callbackRequestParams struct {
	Code  string `validate:"required,max=512" json:"code"`
	State string `validate:"required,max=512" json:"state"`
}

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
	TenantID     string
	ClientApp    string
	BindingID    string
	ClientID     string
}

type oidcClientRegistration struct {
	TenantID               string
	AppID                  string
	ClientID               string
	RedirectOrigins        []redirectOrigin
	SessionBindingRequired bool
}

var (
	oidcClientRegistrationsMu   sync.Mutex
	oidcClientRegistrationsOnce sync.Once
	oidcClientRegistrations     map[string]map[string]oidcClientRegistration
	oidcClientRegistrationsErr  error
)

// AuthRouteConfig captures configuration for the OAuth routes.
type AuthRouteConfig struct {
	TrustedProxyCIDRs        []string
	AllowInsecureStateCookie bool
}

type httpErrorResponse struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Details   any    `json:"details,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	TraceID   string `json:"traceId,omitempty"`
}

type rateLimitBucket struct {
	Endpoint     string
	IdentityType string
	Window       time.Duration
	Limit        int
}
