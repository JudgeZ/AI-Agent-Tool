# Gateway API

The Gateway API is the secure ingress for the OSS AI Agent Tool. It handles authentication (OAuth 2.1), global rate limiting, audit logging, and routing to internal services (Orchestrator, Indexer).

## Key Features

- **Secure Auth**: OAuth 2.1 with PKCE and signed state cookies (HMAC-SHA256 + AES).
- **Rate Limiting**: Global and per-IP limits with Redis or in-memory backing.
- **Audit Logging**: Structured logs with actor and tenant identification.
- **Routing**:
  - `/api/v1/plan/*` -> Orchestrator
  - `/api/v1/index/*` -> Indexer
  - `/auth/*` -> Internal Auth Handlers
  - `/events` -> Server-Sent Events (SSE) proxy

## Prerequisites

- Go 1.24+
- Docker (for containerized runs)

## Configuration

Copy `.env.example` to `.env` and configure the following critical variables:

```bash
# Service URLs
ORCHESTRATOR_URL=http://localhost:4000
INDEXER_URL=http://localhost:7070

# Secure Cookies (REQUIRED for production)
GATEWAY_COOKIE_HASH_KEY=<64-byte-hex>
GATEWAY_COOKIE_BLOCK_KEY=<32-byte-hex>

# Rate Limiting
GATEWAY_HTTP_IP_RATE_LIMIT_MAX=120
GATEWAY_HTTP_IP_RATE_LIMIT_WINDOW=1m

# Trusted Proxies (CIDRs)
GATEWAY_TRUSTED_PROXY_CIDRS=10.0.0.0/8,172.16.0.0/12
```

See `.env.example` for the full list.

## Architecture

The codebase has been refactored to improve modularity and maintainability:

- **`internal/gateway/`**: Core logic.
  - `auth_*.go`: Authentication logic split into handlers, providers, state management, client registration, and validation.
  - `env_utils.go`: Environment variable helpers with secret file support.
  - `net_utils.go`: Network utilities for IP extraction and trusted proxy handling.
  - `events.go`: SSE proxy handler.
  - `global_rate_limit.go` & `rate_limiter.go`: Rate limiting infrastructure.
  - `file_access.go`: Secure file reading with path traversal protection.

## Development

### Running Locally

```bash
go run main.go
```

### Testing

```bash
# Run all tests
go test ./...

# Run with coverage
make test-coverage
```

## Security Notes

- **TLS**: Production deployments (`RUN_MODE=enterprise` or `NODE_ENV=production`) **must** terminate TLS upstream or enable internal TLS. The gateway will refuse to start with insecure cookie configurations in production modes.
- **Open Redirect**: State cookies are signed and encrypted to prevent tampering with the `redirect_uri`.
- **Trusted Proxies**: Correctly configuring `GATEWAY_TRUSTED_PROXY_CIDRS` is crucial for accurate IP rate limiting and audit logging when running behind load balancers.
