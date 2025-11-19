# GUI Components

This directory contains reusable Svelte components for the OSS AI Agent Tool desktop GUI. All components follow accessibility best practices (WCAG 2.1 AA), support keyboard navigation, and include ARIA attributes for screen readers.

## Component Library

### PlanTimeline.svelte

Real-time plan execution timeline with Server-Sent Events (SSE) streaming.

**Purpose:** Display live updates of plan execution steps as they occur, with automatic reconnection on network failures.

**Features:**
- ✅ **SSE streaming** with automatic reconnection (exponential backoff: 1s → 2s → 4s → max 30s)
- ✅ **Step-by-step visualization** of plan execution
- ✅ **Status indicators**: pending, running, completed, failed, cancelled
- ✅ **Timestamp display** for each step
- ✅ **Error handling** with user-friendly messages
- ✅ **Loading states** during reconnection
- ✅ **Accessibility**: ARIA live regions, semantic HTML, keyboard navigation

**Props:**
```typescript
interface PlanTimelineProps {
  planId: string;              // Unique plan identifier
  sseEndpoint?: string;        // SSE endpoint URL (default: /api/plans/${planId}/events)
  autoReconnect?: boolean;     // Enable automatic reconnection (default: true)
  maxReconnectDelay?: number;  // Maximum reconnection delay in ms (default: 30000)
}
```

**Usage:**
```svelte
<script>
  import PlanTimeline from '$lib/components/PlanTimeline.svelte';
  
  let planId = 'plan-123';
</script>

<PlanTimeline 
  {planId} 
  sseEndpoint="/api/plans/{planId}/events"
  autoReconnect={true}
  maxReconnectDelay={30000}
/>
```

**State flow:**
```
┌─────────────────────────────────────────────────────────────────┐
│                      PlanTimeline State                         │
│                                                                  │
│  idle → connecting → connected → receiving events → complete    │
│           │             │           │                            │
│           │             │           └─> error → reconnecting ───┘│
│           │             │                                         │
│           │             └───> disconnected → reconnecting ───────┘│
│           │                                                       │
│           └───> error → reconnecting ──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**SSE event format:**
```json
{
  "type": "step_started",
  "stepId": "step-1",
  "stepName": "Analyze codebase",
  "status": "running",
  "timestamp": "2024-01-15T10:30:00Z"
}

{
  "type": "step_completed",
  "stepId": "step-1",
  "stepName": "Analyze codebase",
  "status": "completed",
  "output": "Found 42 files to process",
  "timestamp": "2024-01-15T10:30:15Z"
}

{
  "type": "step_failed",
  "stepId": "step-2",
  "stepName": "Execute plan",
  "status": "failed",
  "error": "File not found: package.json",
  "timestamp": "2024-01-15T10:30:30Z"
}
```

**Reconnection behavior:**
```typescript
let reconnectAttempt = 0;
let reconnectDelay = 1000; // Start at 1 second

function reconnect() {
  reconnectAttempt++;
  reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
  
  console.log(`Reconnecting in ${reconnectDelay}ms (attempt ${reconnectAttempt})`);
  
  setTimeout(() => {
    connectSSE();
  }, reconnectDelay);
}

// Reset on successful connection
function onConnect() {
  reconnectAttempt = 0;
  reconnectDelay = 1000;
}
```

**Accessibility features:**
- `role="log"` with `aria-live="polite"` for status updates announced by screen readers
- `aria-label` on timeline container
- `aria-current="step"` on active step
- Semantic HTML (`<ol>`, `<li>`) for step list
- Keyboard navigation (focus management)
- Color-blind friendly status indicators (icons + text labels)

**Visual design:**
```
┌─────────────────────────────────────────────────────┐
│ Plan Timeline                         [Reconnecting]│
├─────────────────────────────────────────────────────┤
│                                                      │
│  ✓ Step 1: Analyze codebase                10:30:00│
│    → Found 42 files to process                      │
│                                                      │
│  ⟳ Step 2: Execute plan                    10:30:15│
│    → Processing...                                  │
│                                                      │
│  ○ Step 3: Generate report                  Pending │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**File reference:** `PlanTimeline.svelte:1-300`

**Tests:** `PlanTimeline.test.ts` (25+ test cases)

---

### ApprovalModal.svelte

Modal dialog for human-in-the-loop approval of plan steps with keyboard trap and diff preview.

**Purpose:** Request user approval before executing potentially destructive or sensitive operations (file writes, API calls, etc.).

**Features:**
- ✅ **Keyboard trap** (Tab/Shift+Tab cycle within modal, Escape to close)
- ✅ **Focus management** (focus first interactive element on open, restore on close)
- ✅ **Backdrop click** to dismiss (configurable)
- ✅ **Diff preview** for file changes via DiffViewer component
- ✅ **Approve/Reject buttons** with keyboard shortcuts (Enter to approve, Escape to reject)
- ✅ **Accessibility**: ARIA dialog role, aria-labelledby, aria-describedby, focus trap
- ✅ **Loading state** during submission

**Props:**
```typescript
interface ApprovalModalProps {
  open: boolean;               // Control modal visibility
  title: string;               // Modal title (e.g., "Approve File Write")
  description?: string;        // Optional description
  stepName: string;            // Plan step name
  action: string;              // Action description (e.g., "Write to src/app.ts")
  diff?: {                     // Optional diff preview
    before: string;
    after: string;
    language?: string;
  };
  loading?: boolean;           // Show loading state during submission
  allowBackdropClose?: boolean; // Allow clicking backdrop to close (default: true)
}
```

**Events:**
```typescript
interface ApprovalModalEvents {
  approve: CustomEvent<void>;  // User clicked Approve or pressed Enter
  reject: CustomEvent<void>;   // User clicked Reject or pressed Escape
  close: CustomEvent<void>;    // Modal closed (any reason)
}
```

**Usage:**
```svelte
<script>
  import ApprovalModal from '$lib/components/ApprovalModal.svelte';
  import { createEventDispatcher } from 'svelte';
  
  const dispatch = createEventDispatcher();
  
  let showModal = false;
  let loading = false;
  
  async function handleApprove() {
    loading = true;
    try {
      await fetch('/api/approvals/approve', {
        method: 'POST',
        body: JSON.stringify({ stepId: 'step-123' })
      });
      showModal = false;
    } finally {
      loading = false;
    }
  }
  
  function handleReject() {
    showModal = false;
    dispatch('reject');
  }
</script>

<ApprovalModal
  open={showModal}
  title="Approve File Write"
  description="The plan wants to modify the following file"
  stepName="Update configuration"
  action="Write to config.json"
  diff={{
    before: '{"version": "1.0.0"}',
    after: '{"version": "1.1.0", "feature": "enabled"}',
    language: 'json'
  }}
  {loading}
  on:approve={handleApprove}
  on:reject={handleReject}
/>
```

**Keyboard interactions:**
- `Tab` / `Shift+Tab`: Navigate between Approve and Reject buttons (trapped within modal)
- `Enter`: Approve action (when focus on Approve button or modal is open)
- `Escape`: Reject/close modal
- `Space`: Activate focused button

**Focus trap implementation:**
```typescript
function trapFocus(event: KeyboardEvent) {
  const focusableElements = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstElement = focusableElements[0] as HTMLElement;
  const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
  
  if (event.key === 'Tab') {
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }
}
```

**Accessibility features:**
- `role="dialog"` with `aria-modal="true"`
- `aria-labelledby` pointing to modal title
- `aria-describedby` pointing to modal description
- Focus management: focus first interactive element on open, restore previous focus on close
- Keyboard trap: Tab/Shift+Tab cycle within modal
- Escape key handler
- Screen reader announcements for approve/reject actions

**Visual design:**
```
┌───────────────────────────────────────────────────────────┐
│                       [Backdrop - semi-transparent]        │
│                                                            │
│   ┌─────────────────────────────────────────────────┐    │
│   │ Approve File Write                        [×]   │    │
│   ├─────────────────────────────────────────────────┤    │
│   │                                                  │    │
│   │ The plan wants to modify the following file     │    │
│   │                                                  │    │
│   │ Step: Update configuration                      │    │
│   │ Action: Write to config.json                    │    │
│   │                                                  │    │
│   │ ┌────────────────────────────────────────────┐ │    │
│   │ │ Diff Preview:                             │ │    │
│   │ │ -  "version": "1.0.0"                     │ │    │
│   │ │ +  "version": "1.1.0",                    │ │    │
│   │ │ +  "feature": "enabled"                   │ │    │
│   │ └────────────────────────────────────────────┘ │    │
│   │                                                  │    │
│   │            [Reject]  [Approve]                  │    │
│   │                                                  │    │
│   └─────────────────────────────────────────────────┘    │
│                                                            │
└───────────────────────────────────────────────────────────┘
```

**File reference:** `ApprovalModal.svelte:1-250`

**Tests:** Need to add (see Phase 2 remediation)

---

### DiffViewer.svelte

Minimal diff viewer for displaying before/after file changes.

**Purpose:** Visualize code changes in a readable format with syntax highlighting (optional).

**Features:**
- ✅ **Side-by-side or unified diff** display (configurable)
- ✅ **Line numbers** for easy reference
- ✅ **Syntax highlighting** (optional, via highlight.js or Prism)
- ✅ **Addition/deletion markers** (+ / -)
- ✅ **Line-level diff** highlighting
- ✅ **Compact mode** for small diffs
- ✅ **Accessibility**: Semantic HTML, ARIA labels, keyboard navigation

**Props:**
```typescript
interface DiffViewerProps {
  before: string;              // Original content
  after: string;               // Modified content
  language?: string;           // Syntax highlighting language (e.g., 'typescript', 'json')
  mode?: 'unified' | 'split';  // Display mode (default: 'unified')
  compact?: boolean;           // Compact mode (hide unchanged lines, default: false)
  showLineNumbers?: boolean;   // Show line numbers (default: true)
  contextLines?: number;       // Lines of context around changes (default: 3)
}
```

**Usage:**
```svelte
<script>
  import DiffViewer from '$lib/components/DiffViewer.svelte';
  
  const before = `function hello() {\n  console.log("Hello");\n}`;
  const after = `function hello(name) {\n  console.log("Hello " + name);\n}`;
</script>

<DiffViewer
  {before}
  {after}
  language="typescript"
  mode="unified"
  compact={false}
  showLineNumbers={true}
  contextLines={3}
/>
```

**Unified diff format:**
```
┌─────────────────────────────────────────────────────┐
│ src/app.ts                                          │
├─────────────────────────────────────────────────────┤
│ 1  function hello() {                               │
│ 2    console.log("Hello");                          │
│ 3  }                                                │
│    ────────────────────────────────────────────────│
│ 1  function hello(name) {                           │
│ 2    console.log("Hello " + name);                  │
│ 3  }                                                │
└─────────────────────────────────────────────────────┘

With line-level highlighting:
┌─────────────────────────────────────────────────────┐
│ 1 - function hello() {                              │
│ 1 + function hello(name) {                          │
│ 2 -   console.log("Hello");                         │
│ 2 +   console.log("Hello " + name);                 │
│ 3     }                                             │
└─────────────────────────────────────────────────────┘
```

**Split diff format:**
```
┌─────────────────────────┬─────────────────────────┐
│ Before                  │ After                   │
├─────────────────────────┼─────────────────────────┤
│ 1  function hello() {   │ 1  function hello(name) {│
│ 2    console.log("Hello");│ 2    console.log("Hello " + name);│
│ 3  }                    │ 3  }                    │
└─────────────────────────┴─────────────────────────┘
```

**Compact mode (show only changed lines with context):**
```
┌─────────────────────────────────────────────────────┐
│ ... (3 unchanged lines)                             │
│ 4 - function hello() {                              │
│ 4 + function hello(name) {                          │
│ 5 -   console.log("Hello");                         │
│ 5 +   console.log("Hello " + name);                 │
│ 6     }                                             │
│ ... (10 unchanged lines)                            │
└─────────────────────────────────────────────────────┘
```

**Diff algorithm:**
Uses Myers diff algorithm (via `diff` npm package) for efficient line-based diffing:

```typescript
import { diffLines } from 'diff';

const changes = diffLines(before, after);
// Returns:
// [
//   { value: "function hello() {\n", removed: true },
//   { value: "function hello(name) {\n", added: true },
//   { value: '  console.log("Hello");\n', removed: true },
//   { value: '  console.log("Hello " + name);\n', added: true },
//   { value: "}\n", unchanged: true }
// ]
```

**Syntax highlighting:**
```typescript
import hljs from 'highlight.js';

function highlightCode(code: string, language: string): string {
  return hljs.highlight(code, { language }).value;
}
```

**Accessibility features:**
- `role="region"` with `aria-label="Code diff"`
- Semantic HTML (`<table>` for split mode, `<pre>` for unified mode)
- Color-blind friendly markers (icons + background colors)
- Keyboard navigation (scroll with arrow keys)
- Screen reader support: "Line X, added: [content]" / "Line Y, removed: [content]"

**CSS styling:**
```css
.diff-line-added {
  background-color: #e6ffec; /* Light green */
  border-left: 3px solid #28a745; /* Green border */
}

.diff-line-removed {
  background-color: #ffeef0; /* Light red */
  border-left: 3px solid #d73a49; /* Red border */
}

.diff-line-unchanged {
  background-color: transparent;
}

.diff-line-number {
  color: #6a737d;
  user-select: none;
  width: 40px;
  text-align: right;
  padding-right: 8px;
}
```

**File reference:** `DiffViewer.svelte:1-200`

**Tests:** Need to add (see Phase 2 remediation)

---

## Accessibility Guidelines

All components follow **WCAG 2.1 Level AA** standards.

### Keyboard Navigation

**General principles:**
- All interactive elements must be keyboard accessible (Tab, Shift+Tab)
- Provide visual focus indicators (outline, background change)
- Implement logical tab order
- Support standard keyboard shortcuts (Enter, Escape, Space)

**PlanTimeline:**
- Tab: Navigate to reconnect button (if shown)
- Arrow keys: Scroll timeline (future enhancement)

**ApprovalModal:**
- Tab / Shift+Tab: Cycle between Approve and Reject buttons (keyboard trap)
- Enter: Approve action
- Escape: Reject/close modal
- Space: Activate focused button

**DiffViewer:**
- Tab: Focus on diff region
- Arrow keys: Scroll diff content

### Screen Reader Support

**ARIA attributes:**
- `role="dialog"` for modals
- `role="log"` for live updates (PlanTimeline)
- `role="region"` for content areas (DiffViewer)
- `aria-label` / `aria-labelledby` for component labels
- `aria-describedby` for descriptions
- `aria-live="polite"` for status updates
- `aria-current="step"` for active timeline step
- `aria-modal="true"` for modal dialogs

**Text alternatives:**
- Provide text labels for icon-only buttons
- Include `alt` text for informational images
- Use semantic HTML (`<button>`, `<h1>`, `<nav>`, etc.)

### Color and Contrast

**Minimum contrast ratios:**
- Text: 4.5:1 for normal text, 3:1 for large text (18pt+)
- UI components: 3:1 for active states, borders, icons

**Color-blind friendly:**
- Don't rely solely on color to convey information
- Use icons + text labels for status (✓ Completed, ✗ Failed, ⟳ Running)
- Provide patterns or textures in addition to colors

**DiffViewer color scheme:**
- Green: `#e6ffec` (light), `#28a745` (dark) - additions
- Red: `#ffeef0` (light), `#d73a49` (dark) - deletions
- Contrast ratios: 7.2:1 (light), 4.8:1 (dark) - exceeds AA standards

### Focus Management

**Focus indicators:**
```css
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid #0366d6;
  outline-offset: 2px;
}
```

**Focus order:**
1. Modal opens → focus first interactive element
2. Tab through elements in logical order
3. Modal closes → restore previous focus

**Skip links (future enhancement):**
```svelte
<a href="#main-content" class="skip-link">Skip to main content</a>
```

---

## Component Testing

### Unit Tests

**Testing philosophy:**
- Test user interactions, not implementation details
- Use `@testing-library/svelte` for user-centric tests
- Mock external dependencies (SSE, fetch)
- Verify accessibility (ARIA, keyboard navigation)

**PlanTimeline tests (`PlanTimeline.test.ts`):**
```typescript
import { render, screen, waitFor } from '@testing-library/svelte';
import { vi } from 'vitest';
import PlanTimeline from './PlanTimeline.svelte';

describe('PlanTimeline', () => {
  it('connects to SSE endpoint on mount', async () => {
    const mockEventSource = vi.fn();
    global.EventSource = mockEventSource;
    
    render(PlanTimeline, { props: { planId: 'plan-123' } });
    
    await waitFor(() => {
      expect(mockEventSource).toHaveBeenCalledWith('/api/plans/plan-123/events');
    });
  });
  
  it('displays step events in order', async () => {
    // Mock SSE events
    const mockEvents = [
      { type: 'step_started', stepName: 'Step 1', status: 'running' },
      { type: 'step_completed', stepName: 'Step 1', status: 'completed' }
    ];
    
    // Render and verify
    render(PlanTimeline, { props: { planId: 'plan-123' } });
    
    await waitFor(() => {
      expect(screen.getByText('Step 1')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
    });
  });
  
  it('announces updates to screen readers', async () => {
    render(PlanTimeline, { props: { planId: 'plan-123' } });
    
    const liveRegion = screen.getByRole('log');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
  });
  
  it('reconnects on connection loss', async () => {
    // Test reconnection logic
  });
});
```

**ApprovalModal tests (need to add):**
```typescript
import { render, screen, fireEvent } from '@testing-library/svelte';
import ApprovalModal from './ApprovalModal.svelte';

describe('ApprovalModal', () => {
  it('traps focus within modal', async () => {
    const { container } = render(ApprovalModal, {
      props: { open: true, title: 'Test', stepName: 'Test', action: 'Test' }
    });
    
    const approveButton = screen.getByText('Approve');
    const rejectButton = screen.getByText('Reject');
    
    approveButton.focus();
    await fireEvent.keyDown(approveButton, { key: 'Tab' });
    expect(rejectButton).toHaveFocus();
    
    await fireEvent.keyDown(rejectButton, { key: 'Tab' });
    expect(approveButton).toHaveFocus(); // Wrapped around
  });
  
  it('emits approve event on Enter key', async () => {
    const { component } = render(ApprovalModal, {
      props: { open: true, title: 'Test', stepName: 'Test', action: 'Test' }
    });
    
    const approveSpy = vi.fn();
    component.$on('approve', approveSpy);
    
    await fireEvent.keyDown(document, { key: 'Enter' });
    expect(approveSpy).toHaveBeenCalled();
  });
  
  it('emits reject event on Escape key', async () => {
    const { component } = render(ApprovalModal, {
      props: { open: true, title: 'Test', stepName: 'Test', action: 'Test' }
    });
    
    const rejectSpy = vi.fn();
    component.$on('reject', rejectSpy);
    
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(rejectSpy).toHaveBeenCalled();
  });
  
  it('restores focus after close', async () => {
    // Test focus restoration
  });
});
```

**DiffViewer tests (need to add):**
```typescript
import { render, screen } from '@testing-library/svelte';
import DiffViewer from './DiffViewer.svelte';

describe('DiffViewer', () => {
  it('renders additions and deletions', () => {
    render(DiffViewer, {
      props: {
        before: 'line 1\nline 2',
        after: 'line 1\nline 2 modified',
        mode: 'unified'
      }
    });
    
    expect(screen.getByText(/line 2 modified/)).toBeInTheDocument();
  });
  
  it('shows line numbers when enabled', () => {
    render(DiffViewer, {
      props: {
        before: 'line 1',
        after: 'line 1',
        showLineNumbers: true
      }
    });
    
    expect(screen.getByText('1')).toBeInTheDocument();
  });
  
  it('applies syntax highlighting', () => {
    render(DiffViewer, {
      props: {
        before: 'const x = 1;',
        after: 'const x = 2;',
        language: 'javascript'
      }
    });
    
    // Verify syntax highlighting classes applied
  });
  
  it('supports compact mode', () => {
    // Test compact mode with context lines
  });
});
```

### Integration Tests

**Full flow tests:**
```typescript
describe('Approval Flow', () => {
  it('shows approval modal when plan step requires approval', async () => {
    // 1. Render PlanTimeline
    // 2. Mock SSE event: step requires approval
    // 3. Verify ApprovalModal opens
    // 4. Verify DiffViewer shows changes
    // 5. Approve action
    // 6. Verify approval sent to backend
    // 7. Verify timeline updates
  });
});
```

---

## Styling and Theming

### CSS Variables (Design Tokens)

```css
:root {
  /* Colors */
  --color-primary: #0366d6;
  --color-success: #28a745;
  --color-warning: #ffc107;
  --color-danger: #d73a49;
  --color-neutral: #6a737d;
  
  /* Backgrounds */
  --bg-primary: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-hover: #0366d6;
  
  /* Text */
  --text-primary: #24292e;
  --text-secondary: #6a737d;
  --text-inverted: #ffffff;
  
  /* Borders */
  --border-color: #e1e4e8;
  --border-radius: 6px;
  
  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  
  /* Typography */
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-size-sm: 12px;
  --font-size-md: 14px;
  --font-size-lg: 16px;
  --font-weight-normal: 400;
  --font-weight-bold: 600;
  
  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.12);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 20px rgba(0, 0, 0, 0.15);
  
  /* Transitions */
  --transition-fast: 150ms ease-in-out;
  --transition-normal: 250ms ease-in-out;
  --transition-slow: 500ms ease-in-out;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --text-primary: #c9d1d9;
    --text-secondary: #8b949e;
    --border-color: #30363d;
  }
}
```

### Component-Specific Styles

**PlanTimeline:**
```css
.plan-timeline {
  font-family: var(--font-family);
  padding: var(--spacing-md);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
}

.timeline-step {
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  border-left: 3px solid var(--border-color);
}

.timeline-step.running {
  border-left-color: var(--color-primary);
}

.timeline-step.completed {
  border-left-color: var(--color-success);
}

.timeline-step.failed {
  border-left-color: var(--color-danger);
}
```

**ApprovalModal:**
```css
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  animation: fadeIn var(--transition-fast);
}

.modal-content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--bg-primary);
  padding: var(--spacing-lg);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-lg);
  max-width: 600px;
  width: 90%;
  z-index: 1001;
  animation: slideIn var(--transition-normal);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translate(-50%, -48%);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}
```

---

## Best Practices

1. **Accessibility first:**
   - Always include ARIA attributes
   - Test with screen readers (NVDA, JAWS, VoiceOver)
   - Implement keyboard navigation
   - Ensure color contrast meets WCAG AA standards

2. **Performance:**
   - Use `{#key}` blocks to optimize re-renders
   - Debounce expensive operations (e.g., diff calculations)
   - Lazy load large components
   - Minimize bundle size (tree-shaking)

3. **Error handling:**
   - Show user-friendly error messages
   - Provide retry mechanisms (e.g., SSE reconnection)
   - Log errors to observability system
   - Never expose stack traces to users

4. **Testing:**
   - Write tests for all interactive components
   - Test keyboard navigation and focus management
   - Mock external dependencies (SSE, fetch)
   - Verify accessibility with automated tools (axe, pa11y)

5. **Documentation:**
   - Document component props with TypeScript interfaces
   - Provide usage examples
   - Document accessibility features
   - Include visual design references

---

## Future Enhancements

1. **PlanTimeline:**
   - [ ] Export timeline to JSON/CSV
   - [ ] Filter/search steps
   - [ ] Collapsible step details
   - [ ] Performance metrics overlay

2. **ApprovalModal:**
   - [ ] Multi-step approval workflow
   - [ ] Approval comments/notes
   - [ ] Approval history
   - [ ] Delegate approval to another user

3. **DiffViewer:**
   - [ ] Word-level diff (not just line-level)
   - [ ] Inline diff editing
   - [ ] Custom diff algorithms (patience, histogram)
   - [ ] Export diff to patch format

4. **New Components:**
   - [ ] ToolOutputViewer - Display tool execution results
   - [ ] ProgressIndicator - Visual progress bar for long-running operations
   - [ ] NotificationToast - Toast notifications for background events
   - [ ] CommandPalette - Keyboard-driven command interface (Cmd+K)

---

## References

- **Files:**
  - `PlanTimeline.svelte` - Real-time plan execution timeline
  - `ApprovalModal.svelte` - Human-in-the-loop approval modal
  - `DiffViewer.svelte` - Minimal diff viewer

- **Tests:**
  - `__tests__/PlanTimeline.test.ts` - PlanTimeline unit tests (25+ cases)
  - Need to add: `ApprovalModal.test.ts`, `DiffViewer.test.ts`

- **Dependencies:**
  - `svelte` - Reactive UI framework
  - `@tauri-apps/api` - Tauri desktop integration
  - `diff` - Myers diff algorithm for line-based diffing
  - `highlight.js` - Syntax highlighting (optional)
  - `@testing-library/svelte` - User-centric testing utilities

- **Standards:**
  - [WCAG 2.1 Level AA](https://www.w3.org/WAI/WCAG21/quickref/)
  - [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
  - [Svelte Accessibility](https://svelte.dev/docs#accessibility-warnings)
