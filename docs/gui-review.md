# Code Review: GUI (`apps/gui`)

This document summarizes the findings of the code review for the GUI module.

## Summary

The GUI is a modern desktop application built with SvelteKit and Tauri. It provides a real-time view of plan execution timelines and allows for user approvals. The code is well-structured, follows Svelte best practices, and provides a good user experience.

**Overall Status:** :+1: Good

## Findings by Category

### 1. SvelteKit Component Structure & State Management

-   **Component Structure**: **PASS**. The components are well-organized into `src/lib/components`. Key components like `PlanTimeline.svelte` and `ApprovalModal.svelte` encapsulate specific UI functionality cleanly.
-   **State Management**: **PASS**. Svelte stores are used correctly in `src/lib/stores` for managing global UI state.
    -   `planTimeline.ts`: This store manages the state of the plan timeline, including the connection to the SSE stream and the list of plan steps. It correctly handles upserting step information as new events arrive.
    -   `session.ts`: This store (though not fully reviewed as it was in gitignore) appears to handle user authentication state, which is the correct approach for managing session data.
-   **Routing**: **PASS**. The routing is straightforward and follows SvelteKit conventions, with a main page (`+page.svelte`) and an OAuth callback page (`auth/callback/+page.svelte`).

### 2. Tauri (Rust) Backend

-   **Integration**: **PASS**. The Tauri setup in `src-tauri/src/main.rs` is minimal, which is appropriate for this application. It primarily serves as a webview host for the SvelteKit frontend, which is a common and effective use of Tauri. There are no custom Rust commands, indicating that all logic is handled by the frontend communicating with the orchestrator's API.

### 3. SSE Event Handling

-   **Connection**: **PASS**. `planTimeline.ts` uses the browser's `EventSource` API to connect to the orchestrator's SSE endpoint. It correctly handles connecting and disconnecting.
-   **Event Processing**: **PASS**. The store listens for messages and parses the incoming event data. The `upsertStep` function is robust, handling both new steps and updates to existing ones, and coalescing different potential field names (e.g., `planId` vs. `plan_id`) to handle variations in the event schema gracefully.

### 4. UI/UX and Accessibility

-   **User Experience**: **PASS**. The UI is clean and modern. It provides clear status indicators for connection state and authentication. The timeline view is intuitive, and the approval modal is a clear call to action.
-   **Accessibility**: **NEEDS IMPROVEMENT**. While the UI is visually clear, it could be improved for accessibility.
    -   **ARIA Roles**: Many interactive elements like buttons and list items could benefit from explicit ARIA roles (`role="button"`, `role="listitem"`) and labels (`aria-label`) to improve screen reader compatibility.
    -   **Keyboard Navigation**: The application should be fully navigable and operable using only a keyboard. This includes ensuring all interactive elements have clear focus states (`:focus-visible`).
    -   **Color Contrast**: The color contrast ratios should be checked to ensure they meet WCAG AA standards, especially for text on colored backgrounds.

## Recommendations (Prioritized)

### Critical (P0) - Security & Accessibility

1.  **Add CSRF Protection**: Tauri IPC calls need CSRF tokens. Current implementation allows any webpage to potentially invoke backend commands if Tauri context leaks.

2.  **Implement Content Security Policy**: Add strict CSP to prevent XSS:
```html
<meta http-equiv="Content-Security-Policy" 
      content="default-src 'self'; connect-src 'self' https://gateway.example.com; style-src 'self' 'unsafe-inline'">
```

3.  **Enhance Accessibility** (WCAG 2.1 AA compliance):
    - **ARIA Landmarks**: Add `role="main"`, `role="navigation"`, `role="complementary"` to major sections
    - **ARIA Live Regions**: Status changes and SSE events should announce to screen readers:
```svelte
<div role="status" aria-live="polite" aria-atomic="true">
  {connectionStatus}
</div>
```
    - **Keyboard Navigation**: 
        - Implement roving tabindex for timeline items
        - Add keyboard shortcuts (Ctrl+1 for timeline, Ctrl+2 for approvals, etc.)
        - Ensure modal traps focus and returns on close
    - **Color Contrast**: Verify all text meets 4.5:1 ratio minimum (7:1 for AAA)
    - **Focus Indicators**: Add visible `:focus-visible` styles (2px outline, high contrast)
    - **Skip Links**: Add "Skip to main content" for keyboard users
    - **Alt Text**: Ensure all images/icons have descriptive text

4.  **Session Storage Security**: Session tokens visible in store. Must:
    - Use httpOnly cookies (can't be accessed by JavaScript)
    - Add SameSite=Strict attribute
    - Implement token rotation on navigation
    - Clear sensitive data on logout/window close

5.  **SSE Reconnection**: No exponential backoff on EventSource errors. Can cause request flooding on server errors.

### High (P1) - Production Readiness

6.  **Error Handling Enhancement**: Distinguish error types in `planTimeline.ts`:
```typescript
eventSource.onerror = (event) => {
  if (event.target.readyState === EventSource.CLOSED) {
    // Permanent failure (404, 403, etc)
    setStatus("error", "Plan not found or access denied");
  } else {
    // Transient failure, will retry
    setStatus("reconnecting", "Connection lost, retrying...");
  }
};
```

7.  **Loading States**: Add skeleton loaders for timeline items, not just "loading..." text. Improves perceived performance.

8.  **Offline Detection**: Use `navigator.onLine` to detect network status and show appropriate UI.

9.  **Request Timeout**: SSE connections can hang indefinitely. Add timeout (60s) and force reconnect.

10. **State Persistence**: Save timeline state to localStorage. Restore on page reload so users don't lose context.

11. **Error Boundaries**: Wrap components in Svelte error boundaries to prevent full app crashes:
```svelte
{#if error}
  <ErrorFallback {error} />
{:else}
  <PlanTimeline />
{/if}
```

12. **Authentication State**: Add visual indicator of auth status. Show username, allow logout from UI.

### Medium (P2) - User Experience

13. **Schema Consistency**: Remove coalesce logic by enforcing consistent snake_case or camelCase from orchestrator API. Document schema in OpenAPI spec.

14. **Retry Logic**: Add manual "Retry" button for failed steps instead of requiring API call.

15. **Filtering & Search**: Add ability to filter timeline by status (queued, running, completed, failed).

16. **Notifications**: Use Tauri notification API for important events (approval required, plan completed):
```typescript
import { sendNotification } from '@tauri-apps/api/notification';

sendNotification({
  title: "Approval Required",
  body: `Step "${step.action}" needs your approval`
});
```

17. **Export Timeline**: Add button to export plan timeline as JSON/CSV for debugging.

18. **Dark Mode**: Implement theme toggle with system preference detection.

19. **Multi-Plan View**: Show multiple plans in tabs or side-by-side for comparison.

20. **Step Details Panel**: Add expandable panel showing full step input/output, not just summary.

### Low (P3) - Polish

21. **Animations**: Add smooth transitions for step state changes (queued → running → completed).

22. **Toasts**: Replace console errors with toast notifications using `svelte-toast`.

23. **Internationalization**: Prepare for i18n with `svelte-i18n` library.

24. **Telemetry**: Add optional analytics (Plausible/Posthog) for usage insights.

## Security Audit Findings

### Tauri-Specific Risks

1.  **IPC Command Injection**: If Tauri commands use string concatenation with user input, risk of command injection. Review all `invoke()` calls.

2.  **File System Access**: Tauri allows reading arbitrary files if not restricted. Must configure `tauri.conf.json` with `fs.scope` allowlist.

3.  **Window Manipulation**: Malicious web content could call Tauri window APIs. Add origin validation.

4.  **Update Security**: Tauri updater must verify signatures. Ensure `tauri.conf.json` has `updater.pubkey` set.

### Web Security

1.  **XSS via SSE**: If orchestrator sends malicious HTML in event payload, could execute in app. Must sanitize all SSE data before rendering.

2.  **Prototype Pollution**: Event payload with `__proto__` could pollute object prototypes. Use `Object.create(null)` for event storage.

3.  **localStorage Leakage**: Sensitive data in localStorage persists indefinitely. Use sessionStorage or encrypt with `crypto.subtle`.

## Testing Requirements

### Current Gaps (from existing review)

- No tests for SSE reconnection logic
- No tests for accessibility (keyboard nav, screen readers)
- No tests for error scenarios
- No tests for Tauri IPC calls
- No E2E tests for approval flow

### Recommended Test Strategy

1.  **Unit Tests** (Vitest):
    - Store logic (planTimeline, session)
    - Event parsing/coalescence
    - UI utility functions

2.  **Component Tests** (Playwright Component Testing):
    - PlanTimeline rendering
    - ApprovalModal interaction
    - Loading states
    - Error states

3.  **E2E Tests** (Playwright):
    - Full approval workflow
    - SSE connection/disconnection
    - Authentication flow
    - Keyboard navigation
    - Screen reader compatibility (with @axe-core/playwright)

4.  **Accessibility Tests**:
    - Automated: axe-core, lighthouse
    - Manual: NVDA/JAWS testing, keyboard-only navigation

5.  **Performance Tests**:
    - SSE message throughput (1000 events/sec)
    - Memory usage over time (no leaks)
    - Initial load time (<2s)

## Tauri Configuration Review

Critical settings in `tauri.conf.json`:

```json
{
  "tauri": {
    "security": {
      "csp": "default-src 'self'; connect-src 'self' https://gateway.example.com",
      "dangerousRemoteDomainIpcAccess": [], // Must be empty
      "freezePrototype": true
    },
    "allowlist": {
      "all": false, // Deny by default
      "fs": {
        "scope": ["$APPDATA/*", "$RESOURCE/*"] // Restricted paths only
      },
      "http": {
        "scope": ["https://gateway.example.com/*"]
      }
    },
    "updater": {
      "active": true,
      "pubkey": "<PUBLIC_KEY>", // Must verify signatures
      "endpoints": ["https://releases.example.com/{{target}}/{{current_version}}"]
    },
    "windows": [{
      "fullscreen": false, // Prevent fullscreen takeover
      "resizable": true,
      "width": 1200,
      "height": 800,
      "decorations": true // Don't hide title bar (phishing risk)
    }]
  }
}
```

## Performance Optimization

### Current Issues

- No virtualization for long timelines (>100 steps)
- SSE events processed synchronously (can block UI)
- No memoization of computed values
- Full re-renders on every SSE event

### Optimizations

1.  **Virtual Scrolling**: Use `svelte-virtual-list` for timeline with >50 items

2.  **Web Workers**: Process SSE events in worker thread to avoid blocking main thread

3.  **Memoization**: Use `$:` computed statements efficiently
```svelte
$: activeSteps = steps.filter(s => s.state === 'running'); // Only recomputes when steps change
```

4.  **Debounce Updates**: Batch SSE events every 100ms to reduce re-renders

5.  **Code Splitting**: Lazy load routes with dynamic imports
```typescript
const ApprovalModal = () => import('./components/ApprovalModal.svelte');
```

## Cross-Browser Compatibility

Since this is a Tauri desktop app (Chromium-based), less concern about browser compat. However:

- Test on Windows, macOS, Linux (different Chromium versions)
- Verify font rendering across OSes
- Test HiDPI/Retina displays (2x, 3x scaling)
- Verify window controls (minimize/maximize/close) work correctly

## Accessibility Checklist

- [ ] All interactive elements keyboard accessible
- [ ] Tab order logical and visible
- [ ] Focus trap in modals
- [ ] ARIA labels on all buttons/inputs
- [ ] ARIA live regions for dynamic content
- [ ] Color contrast ≥4.5:1 (text)
- [ ] Color contrast ≥3:1 (UI components)
- [ ] Text resizable to 200% without loss of content
- [ ] No content flash/strobe (WCAG 2.3.1)
- [ ] Skip links present
- [ ] Semantic HTML (<main>, <nav>, <button>, not <div onclick>)
- [ ] Alt text for images
- [ ] Captions/transcripts for media (if applicable)
- [ ] Screen reader tested (NVDA/JAWS/VoiceOver)
