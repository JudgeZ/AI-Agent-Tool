# Code Review: CLI (`apps/cli`)

This document summarizes the findings of the code review for the CLI module.

## Summary

The CLI is a simple but effective TypeScript application for interacting with the OSS AI Agent Tool from the command line. It provides basic functionality for creating agent profiles and generating plans. The code is straightforward and easy to understand.

**Overall Status:** :+1: Good

## Findings by Category

### 1. TypeScript Command Structure

-   **Structure**: **PASS**. The command structure is simple, with a main `index.ts` that acts as a command dispatcher and `commands/plan.ts` that contains the logic for the `plan` command. This is a reasonable structure for a small number of commands.
-   **Argument Parsing**: **PASS/NEEDS IMPROVEMENT**. Argument parsing is done manually by slicing `process.argv`. While this works for the current simple commands, it would not scale well. Using a dedicated argument parsing library like `yargs` or `commander` would make the CLI more robust and easier to extend with new commands, options, and flags.

### 2. Cross-Platform Compatibility

-   **Compatibility**: **PASS**. The CLI is written in TypeScript and uses standard Node.js APIs (`fs`, `path`), which are cross-platform. The `#!/usr/bin/env node` shebang is the correct way to ensure the script is executed with the user's Node.js installation.

### 3. Error Handling & User Feedback

-   **Error Handling**: **PASS**. The `main` function is wrapped in a `.catch()` block that prints the error and exits with a non-zero status code, which is correct for a CLI application.
-   **User Feedback**: **PASS**. The CLI provides clear, user-friendly output. The `plan` command prints the created plan's ID, goal, steps, and success criteria in a readable format. The `usage` function provides helpful instructions.

## Recommendations (Prioritized)

### Critical (P0) - Architecture & Security

1.  **Fix API Interaction Pattern**: **CRITICAL** - The `plan` command imports `createPlan` directly from orchestrator source (`@oss/orchestrator/plan`). This is architecturally incorrect and won't work in production deployments.

    **Required changes:**
    - Remove direct imports from orchestrator
    - Implement HTTP client to call Gateway API `/plan` endpoint
    - Add authentication (bearer token support)
    - Handle network errors, timeouts, retries
    
    Example:
```typescript
async function createPlan(goal: string): Promise<Plan> {
  const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:8080";
  const token = process.env.AUTH_TOKEN;
  const response = await fetch(`${gatewayUrl}/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token ? `Bearer ${token}` : ""
    },
    body: JSON.stringify({ goal })
  });
  if (!response.ok) {
    throw new Error(`Plan creation failed: ${response.statusText}`);
  }
  return response.json();
}
```

2.  **Add Configuration Management**: Implement config file support (`.aidt.yaml` or `~/.config/aidt/config.yaml`) with environment variable overrides:
```yaml
gateway:
  url: "https://gateway.example.com"
  timeout: 30s
auth:
  token: "${AUTH_TOKEN}"
  method: "bearer" # or "oidc"
```

3.  **Add Input Validation**: Validate goal string before sending to API. Enforce max length (10k chars), check for control characters, prevent injection attacks.

### High (P1) - Usability & Production Readiness

4.  **Adopt Argument Parsing Library**: Replace manual `process.argv` with `yargs` or `commander`:
```typescript
import yargs from "yargs";

yargs(process.argv.slice(2))
  .command("plan <goal>", "Create a new plan", {}, async (argv) => {
    const plan = await createPlan(argv.goal as string);
    console.log(JSON.stringify(plan, null, 2));
  })
  .command("approve <planId> <stepId>", "Approve a step")
  .help()
  .parse();
```

5.  **Add Authentication Flow**: Implement OAuth/OIDC device flow for interactive authentication:
```bash
aidt login        # Opens browser for OAuth
aidt logout       # Clears stored token
aidt whoami       # Shows current user
```

6.  **Implement SSE Event Streaming**: Add command to watch plan execution in real-time:
```bash
aidt watch <planId>   # Connects to /plan/:id/events SSE stream
```

7.  **Add Output Formatting**: Support multiple output formats:
```bash
aidt plan "goal" --format json     # Machine-readable
aidt plan "goal" --format table    # Human-readable table
aidt plan "goal" --format yaml     # YAML output
```

8.  **Error Handling Enhancement**: Distinguish between:
    - Network errors (suggest checking connection)
    - Authentication errors (suggest running `aidt login`)
    - Validation errors (show specific field issues)
    - Server errors (show request ID for support)

### Medium (P2) - Features

9.  **Add Offline Mode**: Cache responses for read-only commands. Enable working without network for common queries.

10. **Interactive Mode**: Add `aidt interactive` for REPL-style command execution with tab completion.

11. **Plan Management Commands**:
```bash
aidt list                           # List recent plans
aidt show <planId>                  # Show plan details
aidt cancel <planId>                # Cancel running plan
aidt retry <planId> <stepId>        # Retry failed step
```

12. **Configuration Commands**:
```bash
aidt config set gateway.url "https://..."
aidt config get gateway.url
aidt config list
```

13. **Progress Indicators**: Add spinners and progress bars for long-running operations using `ora` or `cli-progress`.

14. **Shell Completion**: Generate completion scripts for bash/zsh/fish:
```bash
aidt completion bash > /etc/bash_completion.d/aidt
```

### Low (P3) - Nice to Have

15. **Update Checker**: Periodically check for CLI updates and notify user.

16. **Telemetry**: Optional anonymous usage statistics (with opt-out).

17. **Plugin System**: Allow extending CLI with custom commands.

18. **Aliases**: Support command aliases in config file.

## Security Considerations

### Current Vulnerabilities

1.  **No Authentication**: CLI sends unauthenticated requests. Anyone with network access can use the API.

2.  **Credential Storage**: No secure storage for auth tokens. Must implement:
    - macOS: Keychain API
    - Windows: Credential Manager
    - Linux: Secret Service API / gnome-keyring
    Use `keytar` npm package for cross-platform support.

3.  **HTTPS Verification**: Must verify TLS certificates. Add `--insecure` flag for dev environments only (with warning).

4.  **Token Expiry**: No handling of expired tokens. Must detect 401 responses and re-authenticate.

5.  **Command Injection**: If CLI ever shells out, must sanitize inputs. Currently not an issue but important for future.

### Recommended Security Posture

- Store tokens in OS keychain (never in plaintext files)
- Validate all user inputs before sending to API
- Use HTTPS by default, require explicit flag for HTTP
- Implement certificate pinning for production endpoints
- Add request signing for high-security deployments
- Log security-relevant events (login, logout, failed auth)
- Support MFA/2FA flows for OIDC authentication

## Testing Requirements

### Current Gaps

- No integration tests with live API
- No mocking of network requests
- No tests for error scenarios
- No tests for argument parsing edge cases

### Recommended Test Coverage

1.  **Unit Tests** (target 80%+):
    - Argument parsing logic
    - Config file loading/merging
    - Output formatting functions
    - Error message generation

2.  **Integration Tests**:
    - API request construction
    - Response parsing
    - Authentication flows
    - SSE event streaming

3.  **E2E Tests**:
    - Full workflow: login → create plan → watch → approve
    - Error recovery scenarios
    - Offline mode behavior

4.  **Security Tests**:
    - Token storage/retrieval
    - Certificate validation
    - Input sanitization
    - Auth token rotation

## Cross-Platform Compatibility

### Current Status

✅ Node.js APIs are cross-platform
✅ No OS-specific dependencies yet

### Future Considerations

- Credential storage requires platform-specific APIs
- Path handling must use `path.join()` not string concat
- Line endings (CRLF vs LF) for output
- Colors/formatting in different terminals
- Executable packaging (consider `pkg` or `esbuild` + shebang)

## Performance Targets

- CLI startup time: <200ms (cold), <50ms (warm)
- Plan creation: <2s (network dependent)
- Config loading: <10ms
- Help text generation: <50ms

## Distribution Options

1.  **npm Global Install** (current):
```bash
npm install -g @oss-ai-agent-tool/cli
```

2.  **Standalone Binary** (recommended):
    - Use `pkg` or `esbuild` to create platform-specific binaries
    - Distribute via GitHub Releases
    - Easier for non-Node users

3.  **Package Managers**:
    - Homebrew (macOS): `brew install aidt`
    - Chocolatey (Windows): `choco install aidt`
    - apt/yum (Linux): Distribution-specific packages

4.  **Container Image**:
```bash
docker run ghcr.io/org/aidt plan "my goal"
```
