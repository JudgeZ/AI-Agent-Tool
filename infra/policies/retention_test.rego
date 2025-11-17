package orchestrator.retention

default max_plan_state_days := 30
default max_plan_artifacts_days := 30
default max_secret_logs_days := 30

defaults := data.retention_defaults

plan_state_default := defaults.plan_state_days
plan_artifacts_default := defaults.plan_artifacts_days
secret_log_default := defaults.secret_logs_days
content_capture_default := defaults.content_capture_enabled

test_plan_state_default_within_bounds if {
  plan_state_default <= max_plan_state_days
}

test_plan_artifacts_default_within_bounds if {
  plan_artifacts_default <= max_plan_artifacts_days
}

test_secret_logs_default_within_bounds if {
  secret_log_default <= max_secret_logs_days
}

test_content_capture_disabled_by_default if {
  content_capture_default == false
}
