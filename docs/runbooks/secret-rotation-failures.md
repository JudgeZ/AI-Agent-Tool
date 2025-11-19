# Runbook: Secret Rotation Failures

## Alert Description

**Symptoms:**
- CMEK rotation CronJob failures
- Vault token renewal errors
- Secret version cleanup issues
- "Encryption key not found" errors
- Failed audit events for rotation operations

## Impact

- Data encrypted with old keys may become inaccessible
- Service disruption if Vault tokens expire
- Compliance violations for key rotation requirements
- Potential data decryption failures

## Diagnosis

### 1. Check CronJob status

```bash
# List all rotation-related CronJobs
kubectl get cronjobs -n <namespace> | grep -E "cmek-rotation|secret-cleanup"

# Check recent job runs
kubectl get jobs -n <namespace> --sort-by=.metadata.creationTimestamp

# View failed job logs
kubectl logs job/<failed-job-name> -n <namespace>
```

### 2. Review rotation audit logs

```bash
# Check CMEK rotation events
kubectl logs -l app.kubernetes.io/component=security -n <namespace> | \
  jq 'select(.action | contains("cmek.rotation"))'

# Filter for failures
kubectl logs -l app.kubernetes.io/component=security -n <namespace> | \
  jq 'select(.action | contains("cmek.rotation") and .outcome == "failure")'
```

### 3. Verify Vault connectivity

```bash
# Test Vault connection from pod
kubectl run -it --rm vault-test --image=vault:latest --restart=Never -- \
  vault status -address=${VAULT_ADDR}

# Check Vault token validity
kubectl exec -it <orchestrator-pod> -n <namespace> -- \
  env | grep VAULT

# Test authentication
kubectl exec -it <orchestrator-pod> -n <namespace> -- \
  vault token lookup
```

### 4. Check rotation job configuration

```bash
# View CMEK rotation CronJob
kubectl get cronjob cmek-rotation -n <namespace> -o yaml

# Check schedule and recent execution
kubectl describe cronjob cmek-rotation -n <namespace>

# Review retention settings
kubectl get configmap -n <namespace> -o yaml | grep -A5 retention
```

## Resolution Steps

### Scenario 1: CMEK rotation job failing

**Symptoms:**
- CronJob shows failed status
- "Failed to rotate key for tenant" in logs
- Specific tenants affected

**Solution:**

```bash
# 1. Check job logs for specific error
kubectl logs job/<cmek-rotation-job> -n <namespace>

# 2. Verify Vault service account permissions
kubectl get sa <vault-sa> -n <namespace>

# 3. Test manual rotation for affected tenant
kubectl run -it --rm rotate-test --image=<orchestrator-image> \
  --restart=Never -n <namespace> -- \
  node /app/services/orchestrator/scripts/rotate-all-tenant-cmek.js

# 4. If permission denied, update Vault policy:
vault policy write cmek-rotation - <<EOF
path "secret/data/tenants/*/cmek" {
  capabilities = ["create", "read", "update", "delete"]
}
path "secret/metadata/tenants/*/cmek" {
  capabilities = ["list", "read", "delete"]
}
EOF

# 5. If successful, re-run CronJob:
kubectl create job --from=cronjob/cmek-rotation manual-rotation-1 -n <namespace>
```

### Scenario 2: Vault token expired

**Symptoms:**
- "permission denied" from Vault
- Token renewal service logs show failures
- Multiple services affected

**Solution:**

```bash
# 1. Check token renewal service status
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep VaultTokenRenewal

# 2. Verify token renewal metrics
# In Prometheus:
vault_token_expiry_seconds
vault_token_renewals_total

# 3. Check token renewal configuration
kubectl get deployment oss-ai-orchestrator -n <namespace> \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name | contains("VAULT"))'

# 4. If renewal service not running, enable it:
# values.yaml:
# vault.tokenRenewal.enabled: true

# 5. Force token renewal:
kubectl delete pod -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace>
# Pods will restart and obtain new tokens

# 6. If Kubernetes auth failing, update Vault role:
vault write auth/kubernetes/role/oss-ai-orchestrator \
  bound_service_account_names=oss-ai-orchestrator \
  bound_service_account_namespaces=<namespace> \
  policies=cmek-rotation,secret-read \
  ttl=24h
```

### Scenario 3: Secret version cleanup failing

**Symptoms:**
- Secret version count keeps growing
- "Too many versions" warnings
- Cleanup CronJob fails

**Solution:**

```bash
# 1. Check cleanup job logs
kubectl logs job/<secret-cleanup-job> -n <namespace>

# 2. List secret versions manually
kubectl exec -it <orchestrator-pod> -n <namespace> -- \
  node -e "
  const { VersionedSecretsManager } = require('./src/auth/VersionedSecretsManager');
  // Code to list versions
  "

# 3. Run cleanup in dry-run mode
kubectl set env cronjob/secret-cleanup DRY_RUN=true -n <namespace>
kubectl create job --from=cronjob/secret-cleanup test-cleanup -n <namespace>

# Review what would be deleted
kubectl logs job/test-cleanup -n <namespace>

# 4. If safe, run actual cleanup
kubectl set env cronjob/secret-cleanup DRY_RUN=false -n <namespace>
kubectl create job --from=cronjob/secret-cleanup manual-cleanup -n <namespace>

# 5. Adjust retention if too aggressive:
# values.yaml:
# retention.secrets.retentionVersions: 10  # Keep more versions
```

### Scenario 4: Key version retention overflow

**Symptoms:**
- Disk usage high in Vault
- "Version limit exceeded" errors
- Performance degradation

**Solution:**

```bash
# 1. Check current version counts
vault kv metadata get secret/tenants/<tenant-id>/cmek

# 2. Identify tenants with excessive versions
# Run audit query for version counts

# 3. Clean up old versions for specific tenant:
vault kv metadata delete secret/tenants/<tenant-id>/cmek

# 4. Adjust retention policy:
# values.yaml:
# security.cmek.retentionVersions: 3  # Reduce from 5 to 3

# 5. Force cleanup job:
kubectl create job --from=cronjob/cmek-rotation rotation-cleanup -n <namespace>
```

### Scenario 5: Batch rotation timeout

**Symptoms:**
- CronJob exceeds activeDeadlineSeconds
- Only some tenants rotated
- Job pod killed mid-rotation

**Solution:**

```bash
# 1. Check job deadline
kubectl get cronjob cmek-rotation -n <namespace> \
  -o jsonpath='{.spec.jobTemplate.spec.activeDeadlineSeconds}'

# 2. Increase deadline:
kubectl patch cronjob cmek-rotation -n <namespace> \
  --type=merge -p '{"spec":{"jobTemplate":{"spec":{"activeDeadlineSeconds":1800}}}}'

# 3. Or reduce batch size:
# values.yaml:
# security.cmek.rotation.batchSize: 50  # Reduce from 100

# 4. Or rotate specific tenants only:
# values.yaml:
# security.cmek.rotation.rotateAllTenants: false
# security.cmek.rotation.tenants:
#   - tenant-1
#   - tenant-2

# 5. Complete rotation for missed tenants:
kubectl run -it --rm manual-rotate --image=<orchestrator-image> \
  --restart=Never -n <namespace> -- \
  node /app/services/orchestrator/scripts/rotate-all-tenant-cmek.js
```

### Scenario 6: Audit logging failure

**Symptoms:**
- Rotation succeeds but no audit trail
- Compliance violations
- Missing rotation events

**Solution:**

```bash
# 1. Verify audit logging enabled
kubectl get deployment oss-ai-orchestrator -n <namespace> \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | \
  jq '.[] | select(.name == "AUDIT_ENABLED")'

# 2. Check audit log destination
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  jq 'select(.type == "audit")'

# 3. If logs missing, enable audit:
# values.yaml:
# security.cmek.rotation.auditEnabled: true

# 4. Verify audit sink (Elasticsearch, Loki, etc.)
# Check sink connectivity and quotas

# 5. Backfill audit records from rotation metrics:
# Use Prometheus metrics to reconstruct rotation history
# cmek_rotation_total{tenant="*"}
```

## Temporary Mitigation

If rotation is critical and automated jobs failing:

```bash
# Manual CMEK rotation for critical tenant
kubectl run -it --rm emergency-rotate --image=<orchestrator-image> \
  --restart=Never -n <namespace> -- sh -c '
  node -e "
  const { AuditedCMEKRotation } = require(\"./src/security/AuditedCMEKRotation\");
  const rotation = new AuditedCMEKRotation(/* config */);
  rotation.rotateTenantKey(\"tenant-id\", {
    initiator: \"manual-emergency\",
    reason: \"automated rotation failed\",
    subject: \"ops-team\"
  }).then(console.log);
  "
'

# Manual Vault token renewal
kubectl exec -it <orchestrator-pod> -n <namespace> -- \
  vault token renew
```

## Verification

After implementing fixes:

1. **Verify rotation succeeded**
```bash
# Check latest rotation audit events
kubectl logs -l app.kubernetes.io/component=security -n <namespace> | \
  jq 'select(.action == "cmek.rotation.completed" and .outcome == "success")'
```

2. **Confirm key versions**
```bash
vault kv metadata get secret/tenants/<tenant-id>/cmek
# Should show recent version with current timestamp
```

3. **Test decryption with new key**
```bash
# Attempt to read encrypted artifact
# Should succeed with new CMEK version
```

4. **Monitor rotation metrics**
```bash
# In Prometheus:
cmek_rotation_total
cmek_rotations_failed_total
vault_token_renewals_total
```

## Prevention

1. **Set up rotation monitoring** - Alert on missed rotations
2. **Test rotation regularly** - Don't wait for scheduled runs
3. **Size job timeouts appropriately** - Based on tenant count
4. **Monitor Vault health** - Token expiry, quota usage
5. **Implement gradual rollout** - Rotate small batches first
6. **Maintain audit trail** - Ensure all operations logged
7. **Document tenant exemptions** - Track any rotation exceptions

## Related Alerts

- `CMEKRotationFailed` - Rotation job unsuccessful
- `VaultTokenExpiringSoon` - Token needs renewal
- `SecretVersionOverflow` - Too many versions retained
- `AuditLogMissing` - Audit events not recorded

## Related Documentation

- [AuditedCMEKRotation.ts](../../services/orchestrator/src/security/AuditedCMEKRotation.ts)
- [VaultTokenRenewal.ts](../../services/orchestrator/src/security/VaultTokenRenewal.ts)
- [Secret Cleanup Script](../../services/orchestrator/scripts/cleanup-secret-versions.ts)
- [CMEK Rotation CronJob](../../charts/oss-ai-agent-tool/templates/cmek-rotation-cronjob.yaml)

## Compliance Notes

Failed rotations must be reported to compliance team if:
- Rotation overdue > 7 days beyond policy
- Affects production tenant data
- Results in key version violations
- Prevents data access or recovery
