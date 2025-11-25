# OSS AI Agent Tool CLI

The CLI talks to the Gateway API over HTTP to create plans and interact with the OSS AI Agent Tool services. It no longer bundles the orchestrator workspace directly, so only the CLI dependencies are required for local builds.

## Prerequisites

- Node.js 20+
- A reachable Gateway API (`AIDT_GATEWAY_URL` or `GATEWAY_URL`, defaults to `http://localhost:8080`)
- API key for authentication (`API_KEY` or `AIDT_API_KEY`)

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

### Commands

- `aidt chat <message>` – send a chat request through the Gateway with your API key.
- `aidt code <goal...>` – start a code workflow using the plan endpoint.
- `aidt commit [goal]` – generate a commit message via the Gateway and commit staged changes.
- `aidt ops [cases|workflows]` – list cases and workflows available to your account.

### Gateway URL & security

The CLI validates gateway configuration before sending any requests:

- Gateway URLs must be HTTP(S) and cannot include embedded credentials.
- Requests are only issued to **relative** gateway paths to avoid leaking authorization headers to other hosts.
- HTTP redirects are blocked so headers are never forwarded to an unexpected destination.

Configure Gateway access with environment variables:

```bash
export GATEWAY_URL="https://gateway.example.com"
export API_KEY="<bearer token>"
# Optional timeout override (milliseconds)
export AIDT_GATEWAY_TIMEOUT_MS="45000"
```
