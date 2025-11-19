# Alert Response Guide

## Quick Reference

| Alert | Severity | First Response | Runbook |
|-------|----------|----------------|---------|
| QueueDepthHigh | Warning | Check HPA scaling | [High Queue Depth](./high-queue-depth.md) |
| QueueDepthCritical | Critical | Manual scale up | [High Queue Depth](./high-queue-depth.md) |
| HpaMaxReplicas | Warning | Increase max replicas | [HPA Not Scaling](./hpa-not-scaling.md) |
| HpaDisabled | Warning | Re-enable HPA | [HPA Not Scaling](./hpa-not-scaling.md) |
| ProcessingSlowdown | Warning | Check downstream services | [High Queue Depth](./high-queue-depth.md) |
| DeadLetterQueueHigh | Warning | Investigate message failures | [High Queue Depth](./high-queue-depth.md) |
| AuthenticationFailures | Critical | Check OIDC provider | [Auth Failures](./auth-failures.md) |
| VaultTokenExpiring | Warning | Force token renewal | [Secret Rotation Failures](./secret-rotation-failures.md) |
| CMEKRotationFailed | Warning | Check rotation job | [Secret Rotation Failures](./secret-rotation-failures.md) |
| PurgeJobFailed | Warning | Review job logs | [Data Retention Management](./data-retention-management.md) |

## Alert Triage Process

1. **Acknowledge** - Signal you're investigating
2. **Assess Impact** - How many users/tenants affected?
3. **Check Dependencies** - External services, network, resources
4. **Review Recent Changes** - Deployments, config updates
5. **Follow Runbook** - Execute steps for specific alert
6. **Document** - Update incident log
7. **Resolve** - Fix root cause
8. **Verify** - Confirm alert clears
9. **Post-Mortem** - If significant, schedule review

## Queue & Processing Alerts

### QueueDepthHigh

**Alert Rule:**
```yaml
alert: QueueDepthHigh
expr: orchestrator_queue_depth{queue="plan.steps"} > 100
for: 5m
```

**Impact:** Increased latency, potential backlog

**Quick Fix:**
```bash
# Check current depth
kubectl exec -it <rabbitmq-pod> -n <namespace> -- \
  rabbitmqctl list_queues name messages

# Scale orchestrator
kubectl scale deployment oss-ai-orchestrator -n <namespace> --replicas=10
```

**Detailed Runbook:** [High Queue Depth](./high-queue-depth.md)

---

### QueueDepthCritical

**Alert Rule:**
```yaml
alert: QueueDepthCritical
expr: orchestrator_queue_depth{queue="plan.steps"} > 500
for: 2m
```

**Impact:** Severe backlog, potential data loss risk

**Quick Fix:**
```bash
# Emergency scaling
kubectl scale deployment oss-ai-orchestrator -n <namespace> --replicas=20

# Check broker health
kubectl get pods -l app=rabbitmq -n <namespace>
```

**Detailed Runbook:** [High Queue Depth](./high-queue-depth.md)

---

### KafkaLagHigh

**Alert Rule:**
```yaml
alert: KafkaLagHigh
expr: sum(orchestrator_queue_lag{queue="plan.steps"}) > 100
for: 5m
```

**Impact:** Consumer falling behind, delayed processing

**Quick Fix:**
```bash
# Check consumer group lag
kubectl exec -it <kafka-pod> -n <namespace> -- \
  kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
  --describe --group orchestrator-plan-runtime

# Verify partitions balanced
# Scale to match partition count
```

**Detailed Runbook:** [High Queue Depth](./high-queue-depth.md)

---

### ProcessingSlowdown

**Alert Rule:**
```yaml
alert: ProcessingSlowdown
expr: histogram_quantile(0.95, rate(orchestrator_message_processing_duration_seconds_bucket[5m])) > 30
for: 10m
```

**Impact:** Slow processing, user-visible delays

**Quick Check:**
```bash
# Check Jaeger for slow traces
# Filter by duration > 30s

# Review LLM provider latency
# Check provider status pages

# Database performance
kubectl exec -it <postgres-pod> -n <namespace> -- \
  psql -c "SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"
```

---

### DeadLetterQueueHigh

**Alert Rule:**
```yaml
alert: DeadLetterQueueHigh
expr: rate(orchestrator_messages_dead_lettered_total[5m]) > 1
for: 5m
```

**Impact:** Messages failing repeatedly, potential data loss

**Quick Check:**
```bash
# Sample dead letter messages
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep "dead_letter" | tail -10

# Check for patterns
# - Authentication failures
# - Validation errors
# - Timeout errors
```

## HPA & Scaling Alerts

### HpaMaxReplicas

**Alert Rule:**
```yaml
alert: HpaMaxReplicas
expr: kube_horizontalpodautoscaler_status_current_replicas == kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
```

**Impact:** Cannot scale further, backlog may grow

**Quick Fix:**
```bash
# Increase max replicas
kubectl patch hpa oss-ai-orchestrator -n <namespace> \
  --type=merge -p '{"spec":{"maxReplicas":30}}'
```

---

### HpaDisabled

**Alert Rule:**
```yaml
alert: HpaDisabled
expr: kube_horizontalpodautoscaler_status_condition{condition="ScalingActive",status="false"} == 1
for: 5m
```

**Impact:** Manual scaling only, no auto-response to load

**Quick Fix:**
```bash
# Check HPA status
kubectl describe hpa oss-ai-orchestrator -n <namespace>

# Common causes:
# - Metrics unavailable
# - Invalid configuration
# - Deployment scaled to 0
```

---

### MetricsAbsent

**Alert Rule:**
```yaml
alert: MetricsAbsent
expr: absent(orchestrator_queue_depth{queue="plan.steps"})
for: 5m
```

**Impact:** Monitoring blind spot, HPA may not work

**Quick Fix:**
```bash
# Verify orchestrator running
kubectl get pods -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace>

# Check metrics endpoint
kubectl port-forward -n <namespace> <orchestrator-pod> 4000:4000
curl http://localhost:4000/metrics | grep orchestrator_queue
```

## Authentication Alerts

### AuthenticationFailures

**Alert Rule:**
```yaml
alert: AuthenticationFailures
expr: rate(auth_failures_total[5m]) > 0.1
for: 5m
```

**Impact:** Users cannot log in

**Quick Fix:**
```bash
# Check OIDC provider
curl -v "${OIDC_ISSUER}/.well-known/openid-configuration"

# Review auth logs
kubectl logs -l app.kubernetes.io/name=oss-ai-gateway -n <namespace> | \
  grep -i "auth\|oidc" | tail -50
```

**Detailed Runbook:** [Auth Failures](./auth-failures.md)

---

### TokenRefreshFailing

**Alert Rule:**
```yaml
alert: TokenRefreshFailing
expr: rate(auth_token_refresh_failures_total[5m]) > 0.05
for: 10m
```

**Impact:** Sessions expiring prematurely

**Quick Fix:**
```bash
# Check token refresh logs
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep "token.refresh"

# Verify refresh token configuration
# - Lifetime sufficient
# - Rotation enabled
# - OIDC provider settings
```

**Detailed Runbook:** [Auth Failures](./auth-failures.md)

## Security & Rotation Alerts

### VaultTokenExpiring

**Alert Rule:**
```yaml
alert: VaultTokenExpiring
expr: vault_token_expiry_seconds < 300
for: 2m
```

**Impact:** Service disruption if token expires

**Quick Fix:**
```bash
# Force immediate renewal
kubectl delete pod -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace>

# Verify renewal service
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep VaultTokenRenewal
```

**Detailed Runbook:** [Secret Rotation Failures](./secret-rotation-failures.md)

---

### CMEKRotationFailed

**Alert Rule:**
```yaml
alert: CMEKRotationFailed
expr: increase(cmek_rotations_failed_total[1h]) > 0
for: 5m
```

**Impact:** Key rotation overdue, compliance risk

**Quick Fix:**
```bash
# Check rotation job
kubectl get jobs -l job-name=cmek-rotation -n <namespace>

# Review failure logs
kubectl logs job/<failed-job> -n <namespace>
```

**Detailed Runbook:** [Secret Rotation Failures](./secret-rotation-failures.md)

## Data Retention Alerts

### PurgeJobFailed

**Alert Rule:**
```yaml
alert: PurgeJobFailed
expr: kube_job_status_failed{job_name=~".*purge.*"} > 0
for: 5m
```

**Impact:** Data retention not enforced, storage growth

**Quick Fix:**
```bash
# Identify failed job
kubectl get jobs -l app.kubernetes.io/component=maintenance -n <namespace>

# Review logs
kubectl logs job/<purge-job> -n <namespace>

# Manual retry
kubectl create job --from=cronjob/<cronjob-name> manual-retry-$(date +%s) \
  -n <namespace>
```

**Detailed Runbook:** [Data Retention Management](./data-retention-management.md)

---

### StorageNearFull

**Alert Rule:**
```yaml
alert: StorageNearFull
expr: (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.85
for: 10m
```

**Impact:** Risk of storage exhaustion

**Quick Fix:**
```bash
# Force immediate purge
kubectl create job --from=cronjob/plan-state-purge emergency-purge-$(date +%s) \
  -n <namespace>

kubectl create job --from=cronjob/artifact-purge emergency-artifact-purge-$(date +%s) \
  -n <namespace>

# Monitor storage
kubectl exec -it <postgres-pod> -n <namespace> -- df -h
```

## SLO Violations

### MessageSLOViolation

**Alert Rule:**
```yaml
alert: MessageSLOViolation
expr: rate(orchestrator_messages_processed_total{status="success"}[10m]) / rate(orchestrator_messages_processed_total[10m]) < 0.99
for: 10m
```

**Impact:** Below 99% success rate target

**Quick Check:**
```bash
# Identify failure patterns
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep "status=failed" | tail -50

# Common causes:
# - Provider timeouts
# - Validation errors
# - Database connectivity
```

---

### LatencySLOViolation

**Alert Rule:**
```yaml
alert: LatencySLOViolation
expr: histogram_quantile(0.95, rate(orchestrator_message_processing_duration_seconds_bucket[10m])) > 60
for: 10m
```

**Impact:** P95 latency above 60 second target

**Quick Check:**
```bash
# Open Jaeger, filter by P95+ duration
# Identify slow spans:
# - LLM provider calls
# - Database queries
# - Tool executions
```

## Communication Templates

### User Notification (Major Incident)

```
Subject: [INCIDENT] OSS AI Agent Tool Service Degradation

We are currently experiencing [description of issue]. 

Impact: [what users are experiencing]
Started: [timestamp]
Status: [investigating/identified/monitoring]

We will provide updates every 30 minutes.

Next update: [timestamp]
```

### Incident Resolution

```
Subject: [RESOLVED] OSS AI Agent Tool Service Restored

The issue affecting [component] has been resolved.

Root cause: [brief explanation]
Resolution: [what was done]
Duration: [start] to [end]

Post-mortem: [link or date scheduled]
```

## Escalation Criteria

Escalate immediately if:
- **Critical alerts** not resolved in 15 minutes
- **Multiple services** affected simultaneously
- **Data loss or corruption** suspected
- **Security breach** indicators
- **>50% of users** impacted
- **SLA breach** imminent

## On-Call Handoff Checklist

- [ ] Active incidents documented
- [ ] Recent changes noted
- [ ] Ongoing investigations summarized
- [ ] Scheduled maintenance communicated
- [ ] Contact information verified
- [ ] Access/credentials confirmed working

## Related Documentation

- [Incident Response Process](../processes/incident-response.md)
- [All Runbooks](./README.md)
- [Monitoring Dashboards](../../charts/oss-ai-agent-tool/templates/grafana-dashboard.yaml)
- [Alert Rules](../../charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml)
