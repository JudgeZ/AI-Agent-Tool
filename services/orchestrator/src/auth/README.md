# Authentication & Authorization System

This directory contains the authentication and authorization system for the OSS AI Agent Tool orchestrator. The system supports two deployment modes with distinct authentication flows:

1. **Consumer Mode** - OAuth 2.1 with PKCE for individual users
2. **Enterprise Mode** - OIDC SSO with centralized secret management

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Authentication Layer                         │
│                                                                  │
│  Consumer Mode              Enterprise Mode                     │
│  ┌──────────────┐           ┌──────────────────────┐           │
│  │ OAuthController │         │ OidcController      │           │
│  │ (PKCE flow)   │           │ (SSO flow)          │           │
│  └──────────────┘           └──────────────────────┘           │
│         │                              │                        │
│         ▼                              ▼                        │
│  ┌──────────────┐           ┌──────────────────────┐           │
│  │ LocalKeystore│           │ SecretsStore         │           │
│  │ (Argon2id)   │           │ (Vault/Cloud KMS)    │           │
│  └──────────────┘           └──────────────────────┘           │
│         │                              │                        │
│         └──────────────┬───────────────┘                        │
│                        ▼                                        │
│              ┌──────────────────┐                               │
│              │  SessionStore    │                               │
│              │  (secure cookies)│                               │
│              └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

## Consumer Mode Authentication

**Target users:** Individual developers, small teams, hobbyists

**Flow:** OAuth 2.1 with PKCE (Proof Key for Code Exchange)

### Components

#### OAuthController (`OAuthController.ts`)

Implements OAuth 2.1 authorization code flow with PKCE for secure authentication without client secrets.

**Key features:**
- PKCE with SHA-256 code challenge
- State parameter for CSRF protection
- Secure code verifier generation (43-byte cryptographic random)
- Token exchange with authorization server
- Automatic token refresh

**Flow diagram:**
```
User                    Browser                  OAuth Controller         OAuth Provider
  │                        │                            │                       │
  │  1. Click "Login"      │                            │                       │
  ├───────────────────────>│                            │                       │
  │                        │  2. GET /auth/oauth/login  │                       │
  │                        ├──────────────────────────>│                       │
  │                        │                            │  3. Generate PKCE    │
  │                        │                            │     code_verifier    │
  │                        │                            │     code_challenge   │
  │                        │                            │     state            │
  │                        │                            │                       │
  │                        │  4. 302 Redirect to OAuth Provider               │
  │                        │    with code_challenge, state                      │
  │                        │<───────────────────────────┤                       │
  │                        │                            │                       │
  │                        │  5. User authenticates     │                       │
  │                        ├───────────────────────────────────────────────────>│
  │                        │                            │                       │
  │                        │  6. 302 Redirect with code, state                 │
  │                        │<───────────────────────────────────────────────────┤
  │                        │                            │                       │
  │                        │  7. GET /auth/oauth/callback?code=...&state=...   │
  │                        ├──────────────────────────>│                       │
  │                        │                            │  8. Validate state   │
  │                        │                            │                       │
  │                        │                            │  9. Exchange code    │
  │                        │                            │    + code_verifier   │
  │                        │                            │    for tokens        │
  │                        │                            ├──────────────────────>│
  │                        │                            │                       │
  │                        │                            │ 10. Access token     │
  │                        │                            │     Refresh token    │
  │                        │                            │<──────────────────────┤
  │                        │                            │                       │
  │                        │                            │ 11. Store in         │
  │                        │                            │     LocalKeystore    │
  │                        │                            │                       │
  │                        │ 12. Set session cookie     │                       │
  │                        │     (secure, httpOnly)     │                       │
  │                        │<───────────────────────────┤                       │
  │                        │                            │                       │
  │  13. Logged in         │                            │                       │
  │<───────────────────────┤                            │                       │
```

**Endpoints:**

```typescript
// Initiate OAuth flow
GET /auth/oauth/login
  → Generates PKCE parameters
  → Stores code_verifier in session (short-lived)
  → Redirects to OAuth provider with code_challenge

// OAuth callback
GET /auth/oauth/callback?code=...&state=...
  → Validates state parameter (CSRF protection)
  → Retrieves code_verifier from session
  → Exchanges code + code_verifier for tokens
  → Stores tokens in LocalKeystore
  → Creates authenticated session
  → Redirects to application

// Token refresh (automatic)
POST /auth/oauth/refresh
  → Retrieves refresh token from LocalKeystore
  → Exchanges refresh token for new access token
  → Updates LocalKeystore
  → Returns new access token
```

**Security features:**
- **PKCE:** Protects against authorization code interception attacks
- **State parameter:** Prevents CSRF attacks
- **Short-lived code_verifier:** Stored in session for < 5 minutes
- **Secure token storage:** Tokens encrypted at rest in LocalKeystore
- **Token rotation:** Refresh tokens rotated on each use (if provider supports)

**Configuration:**
```typescript
{
  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID!,
    authUrl: "https://provider.com/oauth/authorize",
    tokenUrl: "https://provider.com/oauth/token",
    redirectUri: "https://myapp.com/auth/oauth/callback",
    scopes: ["openid", "profile", "email"]
  }
}
```

**File reference:** `OAuthController.ts:1-300`

#### LocalKeystore (`LocalKeystore.ts`)

Encrypted local storage for OAuth tokens using Argon2id key derivation.

**Key features:**
- **Argon2id** encryption (memory-hard, resistant to GPU attacks)
- **AES-256-GCM** for token encryption
- **Versioned encryption** (v1 legacy, v2 current with enhanced security)
- **Automatic migration** from v1 to v2 on token access
- **Per-user isolation** via user ID namespace

**Encryption scheme (v2):**
```
User Password (entered once)
    │
    ▼
Argon2id (memory: 65536 KB, iterations: 3, parallelism: 4)
    │
    ▼
32-byte Encryption Key
    │
    ▼
AES-256-GCM (12-byte IV, 16-byte auth tag)
    │
    ▼
Encrypted Token (format: "v2:iv:authTag:ciphertext")
```

**API:**
```typescript
// Initialize keystore with user password
const keystore = new LocalKeystore({
  storagePath: "./data/keystore",
  password: userPassword  // Never logged or stored
});

// Store token
await keystore.setToken(userId, {
  accessToken: "...",
  refreshToken: "...",
  expiresAt: Date.now() + 3600000
});

// Retrieve token
const token = await keystore.getToken(userId);
// Returns: { accessToken, refreshToken, expiresAt } | null

// Delete token (on logout)
await keystore.deleteToken(userId);
```

**Migration from v1 to v2:**
```typescript
// Automatic migration on token read
const token = await keystore.getToken(userId);
// If token stored as v1, automatically re-encrypts as v2
```

**Security considerations:**
- **Password never stored:** User must enter password on each session
- **Key derivation is expensive:** ~100ms per operation (intentional)
- **Memory-hard:** Argon2id uses 64 MB RAM, resistant to ASICs
- **No key caching:** Encryption key derived fresh for each operation
- **File permissions:** Keystore directory must be 0700 (owner-only)

**File structure:**
```
./data/keystore/
├── user-123.json       # Encrypted token for user 123
├── user-456.json       # Encrypted token for user 456
└── .gitignore          # Ensures keystore not committed
```

**File reference:** `LocalKeystore.ts:1-400`

### When to use Consumer Mode

✅ **Use Consumer Mode when:**
- Individual developers or small teams (< 10 users)
- No centralized identity provider
- Users comfortable managing their own OAuth credentials
- Simplified deployment without secret management infrastructure
- Desktop or single-machine deployments

❌ **Don't use Consumer Mode when:**
- Enterprise SSO integration required
- Centralized audit and compliance requirements
- Multi-tenant SaaS deployment
- Need for centralized credential rotation
- Team size > 10 users

---

## Enterprise Mode Authentication

**Target users:** Large teams, enterprises, regulated industries

**Flow:** OIDC (OpenID Connect) with centralized secret management

### Components

#### OidcController (`OidcController.ts`)

Implements OpenID Connect authentication with enterprise identity providers (Okta, Azure AD, Google Workspace, Keycloak).

**Key features:**
- **OIDC Discovery:** Automatic configuration via `.well-known/openid-configuration`
- **ID token validation:** Signature verification, issuer check, audience validation
- **Session management:** Secure cookie-based sessions with CSRF protection
- **Single logout:** Propagates logout to identity provider
- **Multi-tenant support:** Tenant ID extracted from ID token claims

**Flow diagram:**
```
User                    Browser                  OIDC Controller         Identity Provider
  │                        │                            │                       │
  │  1. Access app         │                            │                       │
  ├───────────────────────>│                            │                       │
  │                        │  2. No session, redirect   │                       │
  │                        │     to IdP login           │                       │
  │                        ├──────────────────────────>│                       │
  │                        │                            │  3. Discover OIDC    │
  │                        │                            │     config           │
  │                        │                            ├──────────────────────>│
  │                        │                            │                       │
  │                        │  4. 302 Redirect to IdP    │                       │
  │                        │    with client_id, redirect_uri, nonce, state     │
  │                        │<───────────────────────────┤                       │
  │                        │                            │                       │
  │                        │  5. User authenticates     │                       │
  │                        │     (MFA, SSO, etc)        │                       │
  │                        ├───────────────────────────────────────────────────>│
  │                        │                            │                       │
  │                        │  6. 302 Redirect with code, state                 │
  │                        │<───────────────────────────────────────────────────┤
  │                        │                            │                       │
  │                        │  7. GET /auth/oidc/callback?code=...&state=...    │
  │                        ├──────────────────────────>│                       │
  │                        │                            │  8. Validate state   │
  │                        │                            │                       │
  │                        │                            │  9. Exchange code    │
  │                        │                            │    for tokens        │
  │                        │                            ├──────────────────────>│
  │                        │                            │                       │
  │                        │                            │ 10. ID token         │
  │                        │                            │     Access token     │
  │                        │                            │     Refresh token    │
  │                        │                            │<──────────────────────┤
  │                        │                            │                       │
  │                        │                            │ 11. Validate ID token│
  │                        │                            │     - Signature (JWK)│
  │                        │                            │     - Issuer         │
  │                        │                            │     - Audience       │
  │                        │                            │     - Expiration     │
  │                        │                            │     - Nonce          │
  │                        │                            │                       │
  │                        │                            │ 12. Extract user info│
  │                        │                            │     - email          │
  │                        │                            │     - tenant_id      │
  │                        │                            │     - roles          │
  │                        │                            │                       │
  │                        │                            │ 13. Store tokens in  │
  │                        │                            │     SecretsStore     │
  │                        │                            │     (Vault/KMS)      │
  │                        │                            │                       │
  │                        │ 14. Set session cookie     │                       │
  │                        │     (secure, httpOnly, sameSite)                  │
  │                        │<───────────────────────────┤                       │
  │                        │                            │                       │
  │  15. Logged in         │                            │                       │
  │<───────────────────────┤                            │                       │
```

**Endpoints:**

```typescript
// Initiate OIDC flow
GET /auth/oidc/login
  → Discovers OIDC configuration
  → Generates state and nonce
  → Redirects to identity provider

// OIDC callback
GET /auth/oidc/callback?code=...&state=...
  → Validates state parameter
  → Exchanges code for tokens
  → Validates ID token (signature, claims)
  → Extracts user info and tenant ID
  → Stores tokens in SecretsStore
  → Creates authenticated session
  → Redirects to application

// Single logout
GET /auth/oidc/logout
  → Destroys session
  → Redirects to IdP logout endpoint
  → Clears tokens from SecretsStore
```

**ID token validation:**
```typescript
// Retrieve JWKS (JSON Web Key Set) from IdP
const jwks = await fetchJwks(discoveryDoc.jwks_uri);

// Decode ID token header to get key ID (kid)
const header = decodeJwtHeader(idToken);

// Find matching key in JWKS
const key = jwks.keys.find(k => k.kid === header.kid);

// Verify signature using RSA-256 or ES-256
const verified = verifySignature(idToken, key);

// Validate claims
if (decoded.iss !== expectedIssuer) throw new Error("Invalid issuer");
if (decoded.aud !== clientId) throw new Error("Invalid audience");
if (decoded.exp < Date.now() / 1000) throw new Error("Token expired");
if (decoded.nonce !== expectedNonce) throw new Error("Invalid nonce");
```

**Tenant isolation:**
```typescript
// Extract tenant ID from ID token
const tenantId = idToken.claims["https://myapp.com/tenant_id"];
// or from subdomain:
const tenantId = idToken.claims.hd; // Google Workspace domain
// or from organization claim:
const tenantId = idToken.claims["org_id"]; // Okta organization

// Store tenant ID in session
req.session.tenantId = tenantId;

// All subsequent requests are scoped to tenant
const secrets = await secretsStore.getSecrets(req.session.tenantId);
```

**Configuration:**
```typescript
{
  oidc: {
    discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!, // Stored in Vault
    redirectUri: "https://myapp.com/auth/oidc/callback",
    scopes: ["openid", "profile", "email", "tenant_id"],
    postLogoutRedirectUri: "https://myapp.com"
  }
}
```

**File reference:** `OidcController.ts:1-450`

#### SecretsStore (`SecretsStore.ts`)

Centralized secret management with support for multiple backends.

**Backends:**

1. **LocalFileStore** (development only):
   ```typescript
   const store = new SecretsStore({
     backend: "file",
     path: "./secrets"
   });
   ```

2. **VaultStore** (production):
   ```typescript
   const store = new SecretsStore({
     backend: "vault",
     address: "https://vault.example.com:8200",
     token: process.env.VAULT_TOKEN,  // Auto-renewed
     mount: "secret",
     namespace: "enterprise"
   });
   ```

3. **AwsSecretsManagerStore** (AWS):
   ```typescript
   const store = new SecretsStore({
     backend: "aws",
     region: "us-east-1"
   });
   ```

4. **GcpSecretManagerStore** (GCP):
   ```typescript
   const store = new SecretsStore({
     backend: "gcp",
     projectId: "my-project"
   });
   ```

5. **AzureKeyVaultStore** (Azure):
   ```typescript
   const store = new SecretsStore({
     backend: "azure",
     vaultUrl: "https://myvault.vault.azure.net"
   });
   ```

**API:**
```typescript
// Store secret (multi-tenant)
await store.setSecret(tenantId, "openai-api-key", {
  value: "sk-...",
  metadata: {
    provider: "openai",
    rotatedAt: new Date().toISOString()
  }
});

// Retrieve secret
const secret = await store.getSecret(tenantId, "openai-api-key");
// Returns: { value: "sk-...", metadata: {...} } | null

// List secrets for tenant
const secrets = await store.listSecrets(tenantId);
// Returns: ["openai-api-key", "anthropic-api-key", ...]

// Delete secret
await store.deleteSecret(tenantId, "openai-api-key");
```

**Vault integration:**
- **Token renewal:** Automatic token renewal via `VaultTokenRenewal.ts`
- **Lease management:** Tracks and renews secret leases
- **CMEK rotation:** Customer-managed encryption key rotation (see `AuditedCMEKRotation.ts`)

**File reference:** `SecretsStore.ts:1-500`

#### VersionedSecretsManager (`VersionedSecretsManager.ts`)

Manages multiple versions of secrets for zero-downtime rotation.

**Key features:**
- **Multi-version storage:** Keep 2-5 versions of each secret
- **Graceful rotation:** Old version remains valid during transition
- **Automatic cleanup:** Purges versions older than retention period
- **Audit trail:** Tracks all secret changes with timestamps

**Rotation flow:**
```
1. Admin triggers rotation
   └─> POST /secrets/rotate?tenant=acme&key=openai-api-key

2. VersionedSecretsManager creates new version
   ├─> Version 1 (current): sk-old... [active]
   └─> Version 2 (new):     sk-new... [pending]

3. Update live clients to use Version 2
   ├─> OpenAI provider reloads credentials
   ├─> New requests use Version 2
   └─> In-flight requests still use Version 1

4. After grace period (5 minutes), mark Version 1 as deprecated
   ├─> Version 1: sk-old... [deprecated]
   └─> Version 2: sk-new... [active]

5. After retention period (24 hours), purge Version 1
   └─> Version 2: sk-new... [active]
```

**API:**
```typescript
// Get current version
const secret = await manager.getCurrentVersion(tenantId, key);

// Add new version
await manager.addVersion(tenantId, key, newValue, {
  provider: "openai",
  rotatedBy: "admin@example.com"
});

// List all versions
const versions = await manager.listVersions(tenantId, key);
// Returns: [
//   { version: 2, value: "sk-new...", createdAt: "...", status: "active" },
//   { version: 1, value: "sk-old...", createdAt: "...", status: "deprecated" }
// ]

// Purge old versions
await manager.purgeOldVersions(tenantId, key, retentionHours: 24);
```

**File reference:** `VersionedSecretsManager.ts:1-350`

### When to use Enterprise Mode

✅ **Use Enterprise Mode when:**
- Enterprise SSO integration required (Okta, Azure AD, Google Workspace)
- Centralized secret management (Vault, AWS Secrets Manager, etc.)
- Multi-tenant SaaS deployment
- Compliance requirements (SOC 2, ISO 27001, HIPAA)
- Team size > 10 users
- Centralized audit logging required
- Need for automated credential rotation

❌ **Don't use Enterprise Mode when:**
- Individual developer or small team
- No identity provider infrastructure
- Simplified deployment preferred
- Budget constraints (secret management services have costs)

---

## Token Rotation

### Consumer Mode Token Rotation

**Automatic refresh:**
```typescript
// Middleware checks token expiration
app.use(async (req, res, next) => {
  const token = await keystore.getToken(req.session.userId);
  
  if (token && token.expiresAt < Date.now() + 300000) { // 5 min buffer
    // Token expiring soon, refresh
    const newToken = await oauthController.refreshToken(token.refreshToken);
    await keystore.setToken(req.session.userId, newToken);
  }
  
  next();
});
```

**Manual rotation (user-initiated):**
```typescript
// User revokes token in OAuth provider
// On next request, token validation fails
// User redirected to re-authenticate
app.use(async (req, res, next) => {
  try {
    await validateToken(req.session.token);
    next();
  } catch (error) {
    // Token invalid, clear session and redirect
    req.session.destroy();
    res.redirect("/auth/oauth/login");
  }
});
```

### Enterprise Mode Token Rotation

**Automatic rotation with VersionedSecretsManager:**

```typescript
// Cron job runs hourly
cron.schedule("0 * * * *", async () => {
  const tenants = await db.listTenants();
  
  for (const tenant of tenants) {
    const secrets = await secretsStore.listSecrets(tenant.id);
    
    for (const key of secrets) {
      const lastRotated = await manager.getLastRotationTime(tenant.id, key);
      
      if (Date.now() - lastRotated > 7 * 24 * 3600 * 1000) { // 7 days
        // Rotate secret
        const newValue = await generateNewSecret(key);
        await manager.addVersion(tenant.id, key, newValue);
        
        // Trigger provider client reload
        await notifyProviders(tenant.id, key);
      }
    }
  }
});
```

**Zero-downtime rotation:**
```typescript
// Provider client uses VersionedSecretsManager
class AnthropicProvider {
  private async getApiKey(): Promise<string> {
    const secret = await this.secretsManager.getCurrentVersion(
      this.tenantId,
      "anthropic-api-key"
    );
    return secret.value;
  }
  
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Get fresh API key for each request
    const apiKey = await this.getApiKey();
    const client = new Anthropic({ apiKey });
    
    // Make request
    return await client.messages.create(request);
  }
}
```

**Audit trail:**
```typescript
// Every rotation logged to audit system
await auditLog.log({
  event: "secret_rotated",
  tenantId,
  secretKey,
  actor: "system",
  timestamp: new Date().toISOString(),
  metadata: {
    oldVersion: 1,
    newVersion: 2,
    reason: "scheduled_rotation"
  }
});
```

**Script reference:** `scripts/rotate-all-tenant-cmek.ts`

---

## Audit Logging

All authentication and authorization events are logged to the audit system.

### Events Logged

**Authentication events:**
```typescript
// Login attempt
await auditLog.log({
  event: "auth.login.attempt",
  userId,
  tenantId,
  ipAddress: req.ip,
  userAgent: req.headers["user-agent"],
  timestamp: new Date().toISOString()
});

// Login success
await auditLog.log({
  event: "auth.login.success",
  userId,
  tenantId,
  method: "oidc", // or "oauth"
  ipAddress: req.ip,
  sessionId: req.session.id,
  timestamp: new Date().toISOString()
});

// Login failure
await auditLog.log({
  event: "auth.login.failure",
  userId,
  tenantId,
  reason: "invalid_credentials",
  ipAddress: req.ip,
  timestamp: new Date().toISOString()
});

// Logout
await auditLog.log({
  event: "auth.logout",
  userId,
  tenantId,
  sessionId: req.session.id,
  timestamp: new Date().toISOString()
});
```

**Secret access events:**
```typescript
// Secret read
await auditLog.log({
  event: "secret.read",
  tenantId,
  secretKey,
  userId,
  ipAddress: req.ip,
  timestamp: new Date().toISOString()
});

// Secret write
await auditLog.log({
  event: "secret.write",
  tenantId,
  secretKey,
  userId,
  ipAddress: req.ip,
  version: 2,
  timestamp: new Date().toISOString()
});

// Secret rotation
await auditLog.log({
  event: "secret.rotated",
  tenantId,
  secretKey,
  actor: "system",
  oldVersion: 1,
  newVersion: 2,
  timestamp: new Date().toISOString()
});

// Secret deleted
await auditLog.log({
  event: "secret.deleted",
  tenantId,
  secretKey,
  userId,
  reason: "tenant_offboarding",
  timestamp: new Date().toISOString()
});
```

**Authorization events:**
```typescript
// Policy decision
await auditLog.log({
  event: "policy.decision",
  tenantId,
  userId,
  resource: "plan.execute",
  action: "execute",
  decision: "allow", // or "deny"
  policyId: "policy-123",
  timestamp: new Date().toISOString()
});

// Role assignment
await auditLog.log({
  event: "role.assigned",
  tenantId,
  userId,
  role: "admin",
  assignedBy: "admin@example.com",
  timestamp: new Date().toISOString()
});
```

### Audit Log Storage

**PostgreSQL schema:**
```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  tenant_id TEXT,
  user_id TEXT,
  session_id TEXT,
  ip_address INET,
  user_agent TEXT,
  resource TEXT,
  action TEXT,
  decision TEXT,
  metadata JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, timestamp DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_event ON audit_log(event, timestamp DESC);
```

**Retention policy:**
- Security events: 365 days (configurable)
- Access events: 90 days
- General events: 30 days

**Compliance exports:**
```typescript
// Export audit logs for compliance
GET /audit/export?tenant=acme&start=2024-01-01&end=2024-12-31&format=csv
```

**File reference:** `src/observability/audit.ts:1-300`

---

## Session Management

### SessionStore (`SessionStore.ts`)

Manages user sessions with secure cookie-based storage.

**Session cookie configuration:**
```typescript
app.use(session({
  name: "__Host-session", // Prevents subdomain attacks
  secret: process.env.SESSION_SECRET!, // 32+ byte cryptographic random
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,      // Prevents XSS access
    secure: true,        // HTTPS only
    sameSite: "lax",     // CSRF protection
    maxAge: 3600000,     // 1 hour
    domain: undefined,   // Current domain only
    path: "/"
  },
  store: new PostgresSessionStore({
    connectionString: process.env.DATABASE_URL
  })
}));
```

**Session regeneration:**
```typescript
// Regenerate session ID after login
app.post("/auth/oidc/callback", async (req, res) => {
  // ... token exchange ...
  
  // Regenerate session to prevent fixation attacks
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else resolve(undefined);
    });
  });
  
  // Set authenticated flag
  req.session.authenticated = true;
  req.session.userId = user.id;
  req.session.tenantId = user.tenantId;
  
  res.redirect("/");
});
```

**Session store schema:**
```sql
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_sessions_expire ON sessions(expire);
```

**File reference:** `SessionStore.ts:1-200`

---

## Gateway Authentication (`apps/gateway-api/internal/gateway/auth.go`)

The Go gateway validates sessions and enforces authentication at the edge.

**Middleware:**
```go
func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract session cookie
        cookie, err := r.Cookie("__Host-session")
        if err != nil {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        
        // Validate session in store
        session, err := sessionStore.Get(cookie.Value)
        if err != nil || !session.Authenticated {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        
        // Check session expiration
        if session.ExpiresAt.Before(time.Now()) {
            http.Error(w, "Session expired", http.StatusUnauthorized)
            return
        }
        
        // Add user context
        ctx := context.WithValue(r.Context(), "userId", session.UserID)
        ctx = context.WithValue(ctx, "tenantId", session.TenantID)
        
        // Continue
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

**Cookie security headers:**
```go
w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
w.Header().Set("X-Frame-Options", "DENY")
w.Header().Set("X-Content-Type-Options", "nosniff")
w.Header().Set("X-XSS-Protection", "1; mode=block")
w.Header().Set("Content-Security-Policy", "default-src 'self'")
w.Header().Set("Referrer-Policy", "no-referrer")
```

**File reference:** `apps/gateway-api/internal/gateway/auth.go:1-1600`

---

## Testing

### Unit Tests

**OAuthController:**
- `OAuthController.test.ts` - PKCE generation, token exchange, refresh flow
- 15+ test cases

**LocalKeystore:**
- `LocalKeystore.test.ts` - Encryption, decryption, v1→v2 migration
- 12+ test cases

**OidcController:**
- `OidcController.test.ts` - ID token validation, discovery, logout
- 18+ test cases

**SecretsStore:**
- `SecretsStore.test.ts` - All backends, CRUD operations
- 20+ test cases

**VersionedSecretsManager:**
- `VersionedSecretsManager.test.ts` - Multi-version storage, rotation, cleanup
- 10+ test cases

### Integration Tests

**End-to-end SSO flow:**
- `SsoLoginFlow.e2e.test.ts` - Full OIDC flow from login to logout
- 8+ test scenarios

**Token refresh:**
- `TokenRefresh.test.ts` - Automatic and manual refresh
- 6+ test scenarios

**CMEK rotation:**
- `AuditedCMEKRotation.test.ts` - Customer-managed encryption key rotation
- 5+ test scenarios

**Vault token renewal:**
- `VaultTokenRenewal.test.ts` - Automatic token renewal
- 4+ test scenarios

---

## Best Practices

1. **Choose the right mode:**
   - Consumer Mode: Individual developers, small teams
   - Enterprise Mode: Large teams, compliance requirements

2. **Secure token storage:**
   - Never log tokens or secrets
   - Use encrypted storage (LocalKeystore or SecretsStore)
   - Set appropriate file permissions (0600 for keystore files)

3. **Session security:**
   - Regenerate session ID after login
   - Use `httpOnly`, `secure`, `sameSite` cookies
   - Set reasonable session timeouts (1-4 hours)

4. **Token rotation:**
   - Rotate secrets regularly (7-30 days)
   - Use VersionedSecretsManager for zero-downtime rotation
   - Audit all rotation events

5. **Audit logging:**
   - Log all authentication events
   - Log secret access and changes
   - Include IP address and user agent
   - Set retention policies per compliance requirements

6. **Multi-tenancy:**
   - Always scope secrets by tenant ID
   - Validate tenant ID in ID token
   - Enforce tenant isolation in database queries

7. **Testing:**
   - Test PKCE flow end-to-end
   - Test token expiration and refresh
   - Test session regeneration
   - Test multi-tenant isolation

---

## Configuration Examples

### Consumer Mode (OAuth + LocalKeystore)

```typescript
{
  mode: "consumer",
  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID!,
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    redirectUri: "http://localhost:3000/auth/oauth/callback",
    scopes: ["user:email"]
  },
  keystore: {
    storagePath: "./data/keystore",
    // Password entered by user at runtime
  }
}
```

### Enterprise Mode (OIDC + Vault)

```typescript
{
  mode: "enterprise",
  oidc: {
    discoveryUrl: "https://login.okta.com/.well-known/openid-configuration",
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    redirectUri: "https://myapp.com/auth/oidc/callback",
    scopes: ["openid", "profile", "email", "groups"],
    postLogoutRedirectUri: "https://myapp.com"
  },
  secretsStore: {
    backend: "vault",
    address: process.env.VAULT_ADDR!,
    token: process.env.VAULT_TOKEN!,
    mount: "secret",
    namespace: "enterprise"
  }
}
```

---

## Troubleshooting

### OAuth Issues

**Issue:** PKCE code_verifier not found in session
- **Cause:** Session expired between login and callback
- **Fix:** Increase session TTL or reduce OAuth flow time

**Issue:** Token refresh fails with "invalid_grant"
- **Cause:** Refresh token expired or revoked
- **Fix:** Re-authenticate user with full OAuth flow

### OIDC Issues

**Issue:** ID token signature verification fails
- **Cause:** JWKS cache stale or key rotation
- **Fix:** Refresh JWKS from IdP and retry

**Issue:** Tenant ID not found in ID token
- **Cause:** Incorrect claim mapping
- **Fix:** Configure IdP to include tenant claim in ID token

### Vault Issues

**Issue:** Vault token expired
- **Cause:** Token renewal failed
- **Fix:** Restart VaultTokenRenewal service or manually renew token

**Issue:** Secret not found in Vault
- **Cause:** Secret not yet written or wrong path
- **Fix:** Verify path and write secret with correct tenant namespace

---

## References

- **File structure:**
  - `OAuthController.ts` - OAuth 2.1 with PKCE
  - `LocalKeystore.ts` - Argon2id encrypted token storage
  - `OidcController.ts` - OpenID Connect SSO
  - `SecretsStore.ts` - Multi-backend secret management
  - `VersionedSecretsManager.ts` - Secret versioning and rotation
  - `SessionStore.ts` - Session management
  - `VaultTokenRenewal.ts` - Automatic Vault token renewal
  - `AuditedCMEKRotation.ts` - CMEK rotation with audit trail

- **Tests:**
  - `__tests__/OAuthController.test.ts`
  - `__tests__/LocalKeystore.test.ts`
  - `__tests__/OidcController.test.ts`
  - `__tests__/SecretsStore.test.ts`
  - `__tests__/VersionedSecretsManager.test.ts`
  - `__tests__/SsoLoginFlow.e2e.test.ts`
  - `__tests__/TokenRefresh.test.ts`

- **Scripts:**
  - `scripts/rotate-all-tenant-cmek.ts` - Rotate customer-managed encryption keys
  - `scripts/cleanup-secret-versions.ts` - Purge old secret versions
  - `security/startVaultTokenRenewal.ts` - Start Vault token renewal service

- **Gateway:**
  - `apps/gateway-api/internal/gateway/auth.go` - Gateway authentication middleware
