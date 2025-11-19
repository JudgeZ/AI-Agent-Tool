# Runbook: Authentication Failures

## Alert Description

**Symptoms:**
- Users unable to log in via SSO/OIDC
- "Session expired" errors
- "Token refresh failed" messages
- 401/403 errors in gateway logs

## Impact

- Users cannot access the platform
- Active sessions may be terminated
- API requests fail authentication
- Multi-tenant isolation may be affected

## Diagnosis

### 1. Identify the failure pattern

```bash
# Check recent auth-related audit logs
kubectl logs -l app.kubernetes.io/name=oss-ai-gateway -n <namespace> --tail=500 | \
  grep -i "auth\|oidc\|session"

# Check authentication metrics
# In Prometheus:
rate(auth_failures_total[5m])
auth_session_duration_seconds
```

### 2. Verify OIDC provider availability

```bash
# Test OIDC discovery endpoint
OIDC_ISSUER=$(kubectl get configmap oss-ai-config -n <namespace> \
  -o jsonpath='{.data.OIDC_ISSUER}')

curl -v "${OIDC_ISSUER}/.well-known/openid-configuration"

# Expected: 200 OK with JSON metadata
```

### 3. Check session store health

```bash
# For Redis-backed sessions
kubectl exec -it <redis-pod> -n <namespace> -- redis-cli INFO

# Check memory usage
kubectl exec -it <redis-pod> -n <namespace> -- redis-cli INFO memory

# Count active sessions
kubectl exec -it <redis-pod> -n <namespace> -- redis-cli DBSIZE
```

### 4. Review token refresh logs

```bash
# Check for token refresh failures
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep "token.refresh"

# Look for specific errors:
# - "invalid_grant" = refresh token expired/revoked
# - "upstream_error" = OIDC provider issue
# - "timeout" = network/latency issue
```

## Resolution Steps

### Scenario 1: OIDC provider unreachable

**Symptoms:**
- Discovery endpoint returns 5xx or timeout
- "upstream_error" in logs
- All users affected

**Solution:**

```bash
# 1. Verify provider status
# Check provider's status page (e.g., Auth0, Okta status)

# 2. Test network connectivity
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl -v "${OIDC_ISSUER}/.well-known/openid-configuration"

# 3. Check egress network policies
kubectl get networkpolicies -n <namespace>

# 4. Verify DNS resolution
kubectl run -it --rm debug --image=busybox --restart=Never -- \
  nslookup ${OIDC_ISSUER#https://}

# 5. If provider is down, consider:
# - Communicating outage to users
# - Implementing circuit breaker to prevent cascading failures
# - Falling back to alternative auth (if configured)
```

### Scenario 2: Expired/invalid client credentials

**Symptoms:**
- "invalid_client" errors
- Callback failures after successful login
- Specific to one deployment/environment

**Solution:**

```bash
# 1. Verify OIDC client configuration
kubectl get secret oss-ai-oidc-client -n <namespace> -o yaml

# 2. Test client credentials manually
CLIENT_ID=$(kubectl get secret oss-ai-oidc-client -n <namespace> \
  -o jsonpath='{.data.client-id}' | base64 -d)
CLIENT_SECRET=$(kubectl get secret oss-ai-oidc-client -n <namespace> \
  -o jsonpath='{.data.client-secret}' | base64 -d)

# Test token endpoint with client credentials
curl -X POST "${OIDC_ISSUER}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}"

# 3. If credentials invalid, update secret:
kubectl create secret generic oss-ai-oidc-client \
  -n <namespace> \
  --from-literal=client-id=<new-client-id> \
  --from-literal=client-secret=<new-client-secret> \
  --dry-run=client -o yaml | kubectl apply -f -

# 4. Restart gateway and orchestrator
kubectl rollout restart deployment/oss-ai-gateway -n <namespace>
kubectl rollout restart deployment/oss-ai-orchestrator -n <namespace>
```

### Scenario 3: Session store full/unavailable

**Symptoms:**
- "session not found" errors for new logins
- Redis memory maxed out
- Session creation failures

**Solution:**

```bash
# 1. Check Redis memory usage
kubectl exec -it <redis-pod> -n <namespace> -- \
  redis-cli INFO memory | grep used_memory_human

# 2. If memory is full, increase limit:
# Edit values.yaml:
# redis.resources.limits.memory: "512Mi"

# 3. Or enable eviction policy:
kubectl exec -it <redis-pod> -n <namespace> -- \
  redis-cli CONFIG SET maxmemory-policy allkeys-lru

# 4. Clear expired sessions manually (if needed):
kubectl exec -it <redis-pod> -n <namespace> -- \
  redis-cli --scan --pattern "oss_session:*" | xargs redis-cli DEL

# 5. Scale Redis (if using sentinel):
kubectl scale statefulset <redis-sentinel> -n <namespace> --replicas=3
```

### Scenario 4: Token refresh failing

**Symptoms:**
- Users logged out after ~1 hour
- "Refresh token has expired" errors
- Specific to long-running sessions

**Solution:**

```bash
# 1. Check token refresh service logs
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  grep "VaultTokenRenewal\|token.refresh"

# 2. Verify refresh token rotation
# Review audit logs for refresh events:
kubectl logs -l app.kubernetes.io/name=oss-ai-gateway -n <namespace> | \
  jq 'select(.action == "auth.token.refresh")'

# 3. Check OIDC provider refresh token settings
# Verify refresh tokens are:
# - Enabled in OIDC provider
# - Have sufficient lifetime (> session TTL)
# - Rotation is configured

# 4. Adjust session TTL if needed:
# values.yaml:
# auth.oidc.session.ttlSeconds: 7200  # 2 hours

# 5. Enable token refresh metrics monitoring
# Check: vault_token_renewals_total, vault_token_expiry_seconds
```

### Scenario 5: Multi-tenant session isolation breach

**Symptoms:**
- Users seeing data from other tenants
- Session tenant ID mismatch errors
- Cross-tenant access attempts in audit logs

**Solution:**

```bash
# 1. IMMEDIATE: Invalidate all sessions
kubectl exec -it <redis-pod> -n <namespace> -- redis-cli FLUSHDB

# 2. Force all users to re-authenticate
# (Sessions cleared above)

# 3. Review session isolation tests
# Run: npm test -- SessionIsolation.test.ts

# 4. Check for code regression
git log --since="1 week ago" -- "*/SessionStore.ts" "*/OidcController.ts"

# 5. Review audit logs for unauthorized access
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> | \
  jq 'select(.outcome == "failure" and .action | contains("session"))'

# 6. Implement monitoring alert for this scenario
# Add alert for cross-tenant session access attempts
```

### Scenario 6: Certificate/mTLS issues

**Symptoms:**
- "TLS handshake failed" errors
- Gateway-orchestrator communication failures
- Only affects service-to-service auth

**Solution:**

```bash
# 1. Check certificate expiration
kubectl get secret <mtls-cert-secret> -n <namespace> -o yaml | \
  grep -A5 tls.crt | tail -1 | base64 -d | \
  openssl x509 -noout -enddate

# 2. Verify cert-manager renewal
kubectl get certificate -n <namespace>
kubectl describe certificate <cert-name> -n <namespace>

# 3. Force certificate renewal
kubectl delete secret <mtls-cert-secret> -n <namespace>
# cert-manager will recreate

# 4. Restart affected services
kubectl rollout restart deployment/oss-ai-gateway -n <namespace>
kubectl rollout restart deployment/oss-ai-orchestrator -n <namespace>
```

## Temporary Mitigation

Emergency bypass (use only in critical situations):

```bash
# Disable OIDC temporarily (if alternative auth available)
kubectl set env deployment/oss-ai-gateway \
  -n <namespace> OIDC_ENABLED=false

# Note: This may break multi-tenant isolation
# Only use if auth provider is completely down
# Re-enable ASAP
```

## Verification

After implementing fixes:

1. **Test login flow**
```bash
# Use browser or:
curl -L http://localhost:8080/auth/oidc/config
```

2. **Verify session creation**
```bash
# Check session count increasing
kubectl exec -it <redis-pod> -n <namespace> -- \
  redis-cli DBSIZE
```

3. **Monitor auth metrics**
```bash
# In Prometheus:
rate(auth_callback_total{outcome="success"}[5m])
auth_session_active
```

4. **Test token refresh**
```bash
# Wait for session to approach TTL, verify auto-refresh
# Check logs for: "auth.token.refresh" with outcome="success"
```

## Prevention

1. **Monitor OIDC provider SLA** - Set up external monitoring
2. **Rotate credentials proactively** - Before expiration
3. **Size session store appropriately** - Based on active users
4. **Test token refresh** - Include in end-to-end test suite (see `TokenRefresh.test.ts`)
5. **Enable refresh token rotation** - Prevent token reuse
6. **Set up auth health checks** - Continuous OIDC provider availability testing

## Related Runbooks

- [Secret Rotation Failures](./secret-rotation-failures.md)
- [HPA Not Scaling](./hpa-not-scaling.md)

## Related Documentation

- [Enterprise SSO Tests](../../services/orchestrator/src/auth/SsoLoginFlow.e2e.test.ts)
- [Token Refresh Tests](../../services/orchestrator/src/auth/TokenRefresh.test.ts)
- [OIDC Configuration](../../charts/oss-ai-agent-tool/values.yaml#auth.oidc)

## Audit Trail

All authentication events are logged to audit logs:
- `auth.oidc.callback` - Login completion
- `auth.session.get` - Session retrieval
- `auth.token.refresh` - Token renewal
- `auth.logout` - Session termination

Review with:
```bash
kubectl logs -l app.kubernetes.io/component=gateway -n <namespace> | \
  jq 'select(.action | startswith("auth."))'
```
