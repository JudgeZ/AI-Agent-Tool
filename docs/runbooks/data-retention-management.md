# Runbook: Data Retention Management

## Overview

This runbook covers managing automated data retention and purge jobs for:
- Plan execution state (30-day retention)
- Plan artifacts (90-day retention)
- Secret versions (version-based retention)

## Scheduled Jobs

| Job | Schedule | Retention | Batch Size | Dry Run Default |
|-----|----------|-----------|------------|-----------------|
| plan-state-purge | Daily 3 AM | 30 days | 1000 records | false |
| artifact-purge | Weekly Sun 4 AM | 90 days | 100 files | false |
| secret-cleanup | Weekly Sun 5 AM | 5 versions | N/A | false |

## Monitoring Retention Jobs

### Check job status

```bash
# List all retention CronJobs
kubectl get cronjobs -n <namespace> | grep -E "purge|cleanup"

# Check recent execution history
kubectl get jobs -n <namespace> --sort-by=.metadata.creationTimestamp | \
  grep -E "purge|cleanup" | tail -10

# View last execution status
kubectl describe cronjob plan-state-purge -n <namespace>
```

### Review job logs

```bash
# Plan state purge logs
kubectl logs -l job-name=plan-state-purge -n <namespace> --tail=100

# Artifact purge logs  
kubectl logs -l job-name=artifact-purge -n <namespace> --tail=100

# Secret cleanup logs
kubectl logs -l job-name=secret-cleanup -n <namespace> --tail=100
```

### Check metrics

```bash
# In Prometheus:

# Plan state purge
plan_state_purge_total
plan_state_purged_steps
plan_state_purged_plans
plan_state_purge_duration_seconds

# Artifact purge
artifact_purge_total
artifacts_purged_total
artifact_purge_bytes_total
artifact_purge_duration_seconds

# Secret cleanup
secret_cleanup_total
secret_versions_pruned_total
secrets_processed_total
secret_cleanup_duration_seconds
```

## Common Operations

### 1. Manual purge execution

```bash
# Run plan state purge manually
kubectl create job --from=cronjob/plan-state-purge manual-purge-$(date +%s) \
  -n <namespace>

# Run artifact purge manually
kubectl create job --from=cronjob/artifact-purge manual-artifact-purge-$(date +%s) \
  -n <namespace>

# Run secret cleanup manually
kubectl create job --from=cronjob/secret-cleanup manual-secret-cleanup-$(date +%s) \
  -n <namespace>
```

### 2. Dry-run purge (preview deletions)

```bash
# Enable dry-run mode
kubectl set env cronjob/plan-state-purge DRY_RUN=true -n <namespace>

# Run job
kubectl create job --from=cronjob/plan-state-purge dryrun-test-$(date +%s) \
  -n <namespace>

# Review what would be deleted
kubectl logs job/dryrun-test-<timestamp> -n <namespace>

# Disable dry-run mode
kubectl set env cronjob/plan-state-purge DRY_RUN=false -n <namespace>
```

### 3. Adjust retention periods

```bash
# Temporary override via environment variable
kubectl set env cronjob/plan-state-purge PLAN_RETENTION_DAYS=60 -n <namespace>
kubectl set env cronjob/artifact-purge ARTIFACT_RETENTION_DAYS=180 -n <namespace>

# Permanent change in values.yaml:
# retention:
#   planState:
#     retentionDays: 60
#   artifacts:
#     retentionDays: 180
#   secrets:
#     retentionVersions: 10
```

### 4. Pause/resume purge jobs

```bash
# Suspend all purge jobs
kubectl patch cronjob plan-state-purge -n <namespace> \
  -p '{"spec":{"suspend":true}}'
kubectl patch cronjob artifact-purge -n <namespace> \
  -p '{"spec":{"suspend":true}}'
kubectl patch cronjob secret-cleanup -n <namespace> \
  -p '{"spec":{"suspend":true}}'

# Resume jobs
kubectl patch cronjob plan-state-purge -n <namespace> \
  -p '{"spec":{"suspend":false}}'
kubectl patch cronjob artifact-purge -n <namespace> \
  -p '{"spec":{"suspend":false}}'
kubectl patch cronjob secret-cleanup -n <namespace} \
  -p '{"spec":{"suspend":false}}'
```

### 5. Adjust batch sizes

```bash
# For large purge operations, increase batch size
kubectl set env cronjob/plan-state-purge BATCH_SIZE=5000 -n <namespace>
kubectl set env cronjob/artifact-purge BATCH_SIZE=500 -n <namespace>

# For performance concerns, decrease batch size
kubectl set env cronjob/plan-state-purge BATCH_SIZE=100 -n <namespace>
```

## Troubleshooting

### Job timeout

**Symptom:** Job exceeds activeDeadlineSeconds

```bash
# Check job deadline
kubectl get cronjob plan-state-purge -n <namespace> \
  -o jsonpath='{.spec.jobTemplate.spec.activeDeadlineSeconds}'

# Increase deadline
kubectl patch cronjob plan-state-purge -n <namespace> \
  --type=merge -p '{"spec":{"jobTemplate":{"spec":{"activeDeadlineSeconds":7200}}}}'

# Or reduce batch size (see above)
```

### Database lock contention

**Symptom:** "deadlock detected" or "lock timeout" in logs

```bash
# Reduce batch size to minimize transaction time
kubectl set env cronjob/plan-state-purge BATCH_SIZE=100 -n <namespace>

# Run during off-peak hours
kubectl patch cronjob plan-state-purge -n <namespace> \
  -p '{"spec":{"schedule":"0 2 * * *"}}'  # 2 AM instead of 3 AM

# Enable batching with delays (modify script if needed)
```

### Storage backend unavailable

**Symptom:** "Failed to connect to PostgreSQL/S3/Azure" in logs

```bash
# Verify database connectivity
kubectl run -it --rm pg-test --image=postgres:15 --restart=Never -n <namespace> -- \
  psql "${DATABASE_URL}" -c "SELECT version();"

# Check S3/Azure credentials (for artifact purge)
kubectl get secret <storage-credentials> -n <namespace>

# Verify network policies allow egress
kubectl get networkpolicies -n <namespace>
```

### Audit log failures

**Symptom:** Purge succeeds but no audit events

```bash
# Verify audit logging enabled
kubectl get cronjob plan-state-purge -n <namespace> \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name == "AUDIT_ENABLED")'

# Enable if disabled
kubectl set env cronjob/plan-state-purge AUDIT_ENABLED=true -n <namespace>

# Check audit log destination
kubectl logs -l job-name=plan-state-purge -n <namespace> | \
  jq 'select(.action | contains("purge"))'
```

## Legal Hold / Retention Override

### Scenario: Prevent purge for specific tenant

```bash
# Option 1: Suspend purge jobs temporarily
kubectl patch cronjob plan-state-purge -n <namespace> \
  -p '{"spec":{"suspend":true}}'

# Option 2: Modify purge script to exclude tenant
# Add exclusion logic to purge scripts:
# - purge-expired-plan-states.ts
# - purge-expired-artifacts.ts

# Option 3: Backup data before purge
# Run manual backup for affected tenant
pg_dump -t "plan_steps" -t "plan_artifacts" \
  --where="tenant_id='<tenant-id>'" \
  "${DATABASE_URL}" > tenant-backup.sql
```

### Scenario: Emergency data recovery

```bash
# If data recently purged and recovery needed:

# 1. Check backup retention
# Verify PostgreSQL backups available

# 2. Identify purge timestamp from audit logs
kubectl logs -l job-name=plan-state-purge -n <namespace> | \
  jq 'select(.action == "plan_state.purge.completed")' | tail -1

# 3. Restore from backup
# Use Point-in-Time Recovery (PITR) to before purge

# 4. Document incident for compliance
# File incident report with timestamp, scope, resolution
```

## Best Practices

### 1. Monitor purge effectiveness

```bash
# Check data growth trends
# In Prometheus/Grafana:
# - Database size over time
# - Artifact storage usage
# - Secret version counts per key

# Alert if retention not keeping up:
# - Database growing despite purges
# - Storage approaching limits
```

### 2. Test purge in staging first

```bash
# Before production purge policy changes:
# 1. Update staging values.yaml
# 2. Run manual purge with DRY_RUN=true
# 3. Review logs for scope
# 4. Run actual purge
# 5. Verify metrics and audit logs
# 6. Promote to production
```

### 3. Coordinate with backups

```bash
# Ensure backup retention > purge retention
# Example:
# - Purge retention: 30 days
# - Backup retention: 90 days
# Allows recovery window even after purge
```

### 4. Document exceptions

```bash
# Maintain registry of:
# - Tenants with custom retention
# - Data under legal hold
# - Compliance requirements per tenant
# - Retention policy changes
```

## Compliance Reporting

### Generate retention compliance report

```bash
# Count records by age
psql "${DATABASE_URL}" -c "
SELECT 
  DATE_TRUNC('month', created_at) as month,
  state,
  COUNT(*) as record_count
FROM plan_steps
WHERE created_at < NOW() - INTERVAL '30 days'
GROUP BY month, state
ORDER BY month DESC;
"

# Verify purge completeness
psql "${DATABASE_URL}" -c "
SELECT COUNT(*) 
FROM plan_steps 
WHERE state IN ('completed', 'failed', 'rejected', 'dead_lettered')
  AND updated_at < NOW() - INTERVAL '30 days';
"
# Should return 0 if purges working correctly

# Review audit trail
kubectl logs -l app.kubernetes.io/component=maintenance -n <namespace> | \
  jq 'select(.action | contains("purge"))' > purge-audit-$(date +%Y%m).json
```

## Related Documentation

- [Retention Policy](../compliance/retention-policy.md)
- [DPIA - Retention Section](../compliance/dpia.md#5-retention--deletion)
- [Purge Scripts](../../services/orchestrator/scripts/)
- [CronJob Templates](../../charts/oss-ai-agent-tool/templates/)

## Metrics Dashboard

Recommended Grafana panels:
- Purge job success rate (last 30 days)
- Records purged per job
- Database size trend
- Artifact storage usage
- Average purge duration
- Audit event counts by purge type
