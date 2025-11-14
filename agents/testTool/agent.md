---
name: "testTool"
role: "Test Tool"
capabilities:
  - tool.execute
  - plan.read
model:
  provider: auto
  routing: default
  temperature: 0
observability:
  tracingTags:
    - integration-test
constraints:
  - "Use deterministic behavior suitable for automated testing"
  - "Return promptly with mocked responses"
---

# Test Tool Agent

This lightweight profile exists solely to support orchestrator integration tests. It resolves
to a deterministic tool agent that exercises queue plumbing without invoking real providers.
