# OSS AI Agent Tool CLI

The CLI packages the orchestrator SDK for local workflows. Because the CLI depends on the orchestrator workspace, it expects the same toolchain when preparing build artifacts.

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) (the orchestrator uses pnpm to manage dependencies and lockfiles)

Install pnpm with Corepack (bundled with recent Node.js releases):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

## Development workflow

1. Install CLI dependencies in `apps/cli` using your preferred package manager (`npm ci`, `pnpm install`, etc.).
2. Build the orchestrator workspace with pnpm to ensure the SDK artifacts are up to date:

   ```bash
   pnpm install --frozen-lockfile --dir services/orchestrator
   pnpm --dir services/orchestrator run build
   ```

3. Bundle the CLI:

   ```bash
   cd apps/cli
   npm run build
   ```

   The `prebuild` hook automatically installs orchestrator dependencies with pnpm using the lockfile above. Ensure pnpm is available on your PATH before running the build.

4. Run tests as needed:

   ```bash
   npm test
   ```

When contributing changes, keep the orchestrator dependencies managed via pnpm to avoid divergence between the CLI and the core services.
