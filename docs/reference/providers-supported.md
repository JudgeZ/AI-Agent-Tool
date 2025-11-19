# Supported Providers (initial set)

| Provider        | Chat | Embeddings | Auth Modes                 | Notes |
|----------------|------|------------|----------------------------|-------|
| OpenAI         | ✅    | 🔶 Planned | API Key                    | Real completions via official SDK. Embeddings arrive alongside Phase 4 tooling. |
| Anthropic      | ✅    | 🔶 Planned | API Key                    | Claude 3 via Messages API. |
| Google (Gemini)| ✅    | 🔶 Planned | API Key / OAuth / Service Account | OAuth used for consumer tenants; enterprise can supply service accounts. |
| Azure OpenAI   | ✅    | 🔶 Planned | AAD / API Key              | Uses bring-your-own deployment. |
| AWS Bedrock    | ✅    | 🔶 Planned | IAM                        | Calls Bedrock runtime for Anthropic + Cohere routes. |
| Mistral        | ✅    | 🔶 Planned | API Key                    | Chat-first today; embedding support coming with provider SDK update. |
| OpenRouter     | ✅    | 🔶 Planned | API Key / OAuth            | Consumer-friendly multi-model router. Picks OAuth tokens when present. |
| Local (Ollama) | ✅    | 🔶 Planned | None                       | Local HTTP endpoint (`http://127.0.0.1:11434` by default). |

Legend: ✅ Available today · 🔶 Planned

All adapters resolve credentials through the shared `SecretsStore` abstraction and raise structured `ProviderError` instances
with retry hints so the orchestrator can fail over gracefully.

## Secrets configuration

| Provider | SecretsStore key(s) | Environment fallback | Notes |
|----------|---------------------|-----------------------|-------|
| OpenAI | `provider:openai:apiKey` | `OPENAI_API_KEY` | Required to construct the SDK client. |
| Anthropic | `provider:anthropic:apiKey` | `ANTHROPIC_API_KEY` | Powers Claude 3 via Messages API. |
| Google Gemini | `provider:google:apiKey`, optional `provider:google:serviceAccount`, optional `provider:google:oauthClientId`, optional `provider:google:oauthClientSecret` | `GOOGLE_API_KEY`, `GOOGLE_SERVICE_ACCOUNT`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Provider prefers OAuth tokens (`oauth:google:*`) when present, then service accounts, then API key. |
| Azure OpenAI | `provider:azureopenai:apiKey`, `provider:azureopenai:endpoint`, `provider:azureopenai:deployment` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Deployment name may also be supplied in the chat request. |
| AWS Bedrock | `provider:bedrock:accessKeyId`, `provider:bedrock:secretAccessKey`, optional `provider:bedrock:sessionToken`, optional `provider:bedrock:region` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION` | Region defaults to `us-east-1` when not provided. |
| Mistral | `provider:mistral:apiKey` | `MISTRAL_API_KEY` | Chat support today; embeddings coming with SDK v2. |
| OpenRouter | `provider:openrouter:apiKey` | `OPENROUTER_API_KEY` | Falls back to OAuth access token when available. |
| Local Ollama | `provider:ollama:baseUrl` | `OLLAMA_BASE_URL` | Defaults to `http://127.0.0.1:11434`. |

## OAuth grants

| Provider | SecretsStore key | Scopes / notes |
|----------|------------------|----------------|
| Google Gemini (consumer) | `oauth:google:access_token`, `oauth:google:tokens`, `oauth:google:refresh_token` | Consumer tenants complete PKCE OAuth and the orchestrator stores access/refresh tokens (plus expiry) for reuse and refresh. |
| OpenRouter | `oauth:openrouter:access_token` | Preferred for consumer accounts; SDK falls back to API key when absent. |

### Google Gemini auth flow

1. **OAuth PKCE (consumer mode):** Users authorize via the orchestrator's `/auth/google/*` endpoints. Access, refresh, and token metadata are persisted under `oauth:google:access_token`, `oauth:google:refresh_token`, and `oauth:google:tokens`.
2. **Service account (enterprise mode):** Store the JSON key material in `provider:google:serviceAccount` (or `GOOGLE_SERVICE_ACCOUNT`). The orchestrator mints OAuth tokens via JWT assertions on demand.
3. **API key fallback:** When no OAuth or service account secrets exist, the provider falls back to `provider:google:apiKey` / `GOOGLE_API_KEY` for direct API access.

## Default model routing

| Provider | Default model identifier | Customisation |
|----------|-------------------------|---------------|
| OpenAI | `gpt-4o-mini` | Override per-request via `model` or set a provider default. |
| Anthropic | `claude-3-sonnet-20240229` | `max_tokens` capped at 1024 by default. |
| Google Gemini | `gemini-1.5-flash` | System prompt applied when supplied in messages. |
| Azure OpenAI | Uses configured deployment | Deployment must reference the target model. |
| AWS Bedrock | `anthropic.claude-3-sonnet-20240229-v1:0` | Supports custom region + model id. |
| Mistral | `mistral-large-latest` | Fully controllable via request `model`. |
| OpenRouter | `openrouter/openai/gpt-4o-mini` | Router honors provider overrides/ordering. |
| Local Ollama | `llama3.1` | Base URL configurable per-tenant. |
