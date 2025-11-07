# OSS AI Agent Tool CLI

The CLI talks to the Gateway API over HTTP to create plans and interact with the OSS AI Agent Tool services. It no longer bundles the orchestrator workspace directly, so only the CLI dependencies are required for local builds.

## Prerequisites

- Node.js 20+
- A reachable Gateway API (`AIDT_GATEWAY_URL`, defaults to `http://localhost:8080`)
- (Optional) Bearer token for authentication (`AIDT_AUTH_TOKEN`)

## Development workflow

1. Install CLI dependencies in `apps/cli`:

   ```bash
   cd apps/cli
   npm run build
   ```

2. Run tests as needed:

   ```bash
   npm test
   ```
   Tests spin up a stub HTTP server; no orchestrator checkout is required.

Configure Gateway access with environment variables:

```bash
export AIDT_GATEWAY_URL="https://gateway.example.com"
export AIDT_AUTH_TOKEN="<bearer token>"
# Optional timeout override (milliseconds)
export AIDT_GATEWAY_TIMEOUT_MS="45000"
```
