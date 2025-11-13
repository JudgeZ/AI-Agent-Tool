package orchestrator.capabilities

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

requires_approval(capability) if {
  capability == "repo.write"
}

requires_approval(capability) if {
  capability == "network.egress"
}

policy_capabilities := object.get(object.get(input, "context", {}), "capabilities", {})

role_bindings := object.get(policy_capabilities, "role_bindings", {})

tenant_role_bindings := object.get(policy_capabilities, "tenant_role_bindings", {})

subject_capabilities := object.get(input.subject, "capabilities", [])

subject_roles := object.get(input.subject, "roles", [])

tenant_id := object.get(input.subject, "tenant_id", "")

action_capabilities := object.get(input.action, "capabilities", [])

subject_approvals := object.get(input.subject, "approvals", {})

subject_has_capability(cap) if {
  subject_count := count([1 | subject_capabilities[_] == cap])
  role_count := count([
    1 |
    role := subject_roles[_]
    caps := object.get(role_bindings, role, [])
    caps[_] == cap
  ])
  tenant_count := count([
    1 |
    tenant_id != ""
    role := subject_roles[_]
    tenant_caps := object.get(object.get(tenant_role_bindings, tenant_id, {}), role, [])
    tenant_caps[_] == cap
  ])
  subject_count + role_count + tenant_count > 0
}

approval_missing(cap) if {
  requires_approval(cap)
  object.get(subject_approvals, cap, false) != true
}

run_mode_mismatch if {
  required := object.get(input.action, "run_mode", "")
  required != ""
  required != "any"
  subject := object.get(input.subject, "run_mode", "")
  subject != required
}

deny contains {"reason": "missing_capability", "capability": cap} if {
  cap := action_capabilities[_]
  not subject_has_capability(cap)
}

deny contains {"reason": "approval_required", "capability": cap} if {
  cap := action_capabilities[_]
  approval_missing(cap)
}

deny contains {"reason": "run_mode_mismatch"} if {
  run_mode_mismatch
}

has_missing_capability if {
  cap := action_capabilities[_]
  not subject_has_capability(cap)
}

has_missing_approval if {
  cap := action_capabilities[_]
  approval_missing(cap)
}

allow if {
  not has_missing_capability
  not has_missing_approval
  not run_mode_mismatch
}

