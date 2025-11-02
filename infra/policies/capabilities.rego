package capabilities

# Capability-based authorization rules for orchestrator actions.
#
# Expected input shape:
# {
#   "subject": {
#     "agent": "code-writer",
#     "capabilities": ["repo.read", "repo.write"],
#     "approvals": {
#       "repo.write": true
#     },
#     "run_mode": "consumer" | "enterprise"
#   },
#   "action": {
#     "type": "step.execute" | "http.request" | ...,
#     "capabilities": ["repo.write"],
#     "run_mode": "consumer" | "enterprise" | "any"
#   }
# }

default allow := false

requires_approval[capability] {
  capability := {
    "repo.write",
    "network.egress"
  }[_]
}

subject_capabilities[cap] {
  capabilities := object.get(input.subject, "capabilities", [])
  cap := capabilities[_]
}

action_capabilities[cap] {
  capabilities := object.get(input.action, "capabilities", [])
  cap := capabilities[_]
}

subject_approvals[cap] {
  approvals := object.get(input.subject, "approvals", {})
  object.get(approvals, cap, false) == true
}

missing_capability[cap] {
  action_capabilities[cap]
  not subject_capabilities[cap]
}

missing_approval[cap] {
  action_capabilities[cap]
  requires_approval[cap]
  not subject_approvals[cap]
}

run_mode_mismatch {
  required := object.get(input.action, "run_mode", "")
  required != ""
  required != "any"
  subject := object.get(input.subject, "run_mode", "")
  subject != required
}

deny[{
  "reason": "missing_capability",
  "capability": cap
}] {
  cap := missing_capability[_]
}

deny[{
  "reason": "approval_required",
  "capability": cap
}] {
  cap := missing_approval[_]
}

deny[{"reason": "run_mode_mismatch"}] {
  run_mode_mismatch
}

allow {
  count(deny) == 0
}

