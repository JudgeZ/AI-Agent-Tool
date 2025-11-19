# Model Provider Authentication

We support **API key** and **OAuth/OIDC** (where providers allow it).

## Remote providers (examples)
- **OpenAI**: API key (OAuth not generally available for inference). 
- **Anthropic**: API key.
- **Google (Gemini)**: OAuth (consumer) or Service Account (enterprise).
- **Azure OpenAI**: Azure AD (service principal) or API key.
- **AWS Bedrock**: AWS IAM roles/keys.
- **Mistral**: API key.
- **OpenRouter**: API key or OAuth (consumer-friendly).

## Local providers
- **Ollama / llama.cpp**: local HTTP endpoint or CLI; no external auth.

## How it works
- The **gateway-api** exposes:
  - `GET /auth/:provider/authorize` → generates PKCE + state, stores them temporarily, and redirects to the provider auth page.
  - `GET /auth/:provider/callback` → verifies state, posts the auth code + PKCE verifier to the orchestrator, then redirects the user back to the requested HTTPS destination.
- The **orchestrator** loads credentials via `SecretsStore` and injects them into provider SDKs.
- In **consumer mode**, tokens live in an encrypted local keystore. In **enterprise**, tokens are rotated and stored in Vault or cloud secret managers.

## Loopback OAuth (developer mode)

Some desktop clients (CLI / GUI) use a loopback redirect during OAuth consent. We support this by allowing `http://127.0.0.1` and `http://localhost` redirect URIs while requiring HTTPS everywhere else.

1. The client opens `GET /auth/:provider/authorize?redirect_uri=https://app.example.com/oauth-complete` (or a loopback URL during development).
2. The gateway generates a PKCE verifier + challenge, caches them with a random state, and redirects the browser to the provider's authorization page.
3. After consent, the provider calls back to `GET /auth/:provider/callback?code=...&state=...` on the gateway.
4. The gateway resolves the saved PKCE verifier, POSTs `{ code, code_verifier, redirect_uri }` to the orchestrator, and, on success, redirects the user to the original `redirect_uri` with `status=success`.
5. The orchestrator exchanges the code for tokens, encrypts them with a password-derived key (scrypt + XSalsa20-Poly1305 secretbox), and persists them to disk via the `LocalFileStore` keystore.

### Configuration

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`: OAuth client credentials for Google (Gemini). The gateway redirects to `https://accounts.google.com/o/oauth2/v2/auth` and requests scopes: `openid`, `profile`, `email`, `https://www.googleapis.com/auth/cloud-platform`.
- `OPENROUTER_CLIENT_ID` / `OPENROUTER_CLIENT_SECRET`: OAuth client credentials for OpenRouter.
- `OAUTH_REDIRECT_BASE`: Public base URL for the gateway callback (defaults to `http://127.0.0.1:8080`).
- `LOCAL_SECRETS_PASSPHRASE`: Required passphrase for encrypting the local keystore (`config/secrets/local/secrets.json` by default).
- Optional: `LOCAL_SECRETS_PATH` to override the keystore location.

The `LocalFileStore` keystore derives a 256-bit encryption key from the passphrase using scrypt (`N=32768`, `r=8`, `p=1`) and seals secrets with XSalsa20-Poly1305. The same format is shared by the CLI and desktop clients so tokens remain portable across orchestrator restarts.
