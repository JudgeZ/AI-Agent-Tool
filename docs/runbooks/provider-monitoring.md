# Provider Monitoring Operational Runbook

## Overview

This runbook provides operational guidance for monitoring and maintaining the AI provider infrastructure in the OSS-AI-Agent-Tool. It covers monitoring setup, alert response, troubleshooting, and performance optimization.

## Table of Contents

1. [Quick Reference](#quick-reference)
2. [Monitoring Setup](#monitoring-setup)
3. [Key Metrics](#key-metrics)
4. [Alert Response Procedures](#alert-response-procedures)
5. [Troubleshooting Guide](#troubleshooting-guide)
6. [Performance Tuning](#performance-tuning)
7. [Maintenance Procedures](#maintenance-procedures)

---

## Quick Reference

### Critical Endpoints

- **Metrics**: `http://orchestrator:3000/metrics`
- **Provider Health**: `http://orchestrator:3000/health/providers`
- **General Health**: `http://orchestrator:3000/healthz`

### Grafana Dashboards

- **Provider Metrics**: `/d/ossaat-provider-metrics`
- **Queue Health**: `/d/ossaat-queue-health`
- **Cost Attribution**: `/d/ossaat-cost-dashboard`

### Key Commands

```bash
# Check provider health
curl http://orchestrator:3000/health/providers

# Get current metrics
curl http://orchestrator:3000/metrics | grep orchestrator_provider

# Check pod status
kubectl get pods -l app=orchestrator -n oss-ai

# View logs
kubectl logs -l app=orchestrator -n oss-ai --tail=100

# Describe HPA
kubectl describe hpa orchestrator-hpa -n oss-ai
```

---

## Monitoring Setup

### 1. Enable Monitoring Components

Update `values.yaml`:

```yaml
monitoring:
  serviceMonitor:
    enabled: true
    interval: 30s
  prometheus:
    alerts:
      enabled: true
  grafana:
    enabled: true
    dashboards:
      enabled: true
```

Deploy the configuration:

```bash
helm upgrade oss-ai-agent-tool ./charts/oss-ai-agent-tool \
  -n oss-ai \
  --values values.yaml
```

### 2. Verify Prometheus Scraping

```bash
# Check ServiceMonitor
kubectl get servicemonitor -n oss-ai

# Verify targets in Prometheus
curl http://prometheus:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="orchestrator")'
```

### 3. Import Grafana Dashboards

Dashboards are automatically imported via ConfigMaps:
- `orchestrator-providers.json`: Provider metrics and health
- `orchestrator-queues.json`: Queue and HPA monitoring
- `orchestrator-cost.json`: Cost attribution

---

## Key Metrics

### Provider Request Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `orchestrator_provider_requests_total` | Total requests per provider | - |
| `orchestrator_provider_requests_total{status="error"}` | Failed requests | >5% error rate |
| `orchestrator_provider_latency_seconds` | Request latency histogram | P95 > 5s |
| `orchestrator_provider_timeouts_total` | Request timeouts | >1% timeout rate |

### Token Usage & Cost

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `orchestrator_provider_tokens_total` | Token usage by model/type | 3x spike |
| `orchestrator_provider_cost_dollars_total` | Cumulative cost | >$1000/month rate |

### Circuit Breaker Status

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `orchestrator_provider_circuit_breaker_state` | Circuit breaker state (0=closed, 1=open) | Open for >1m |
| `orchestrator_provider_retries_total` | Retry count | >10% retry rate |

### Cache Performance

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `orchestrator_provider_cache_hits_total` | Cache hits | - |
| `orchestrator_provider_cache_misses_total` | Cache misses | <30% hit rate |

---

## Alert Response Procedures

### ProviderHighErrorRate

**Alert**: Provider has >5% error rate for 5 minutes

**Response**:
1. Check provider status page for outages
2. Review recent error logs:
   ```bash
   kubectl logs -l app=orchestrator -n oss-ai --tail=500 | grep ERROR | grep <provider>
   ```
3. Verify API credentials are valid:
   ```bash
   kubectl get secret orchestrator-secrets -n oss-ai -o yaml
   ```
4. Check rate limiting:
   - Review `orchestrator_provider_requests_total` rate
   - Compare against provider rate limits
5. If persistent, consider:
   - Enabling circuit breaker
   - Switching to fallback provider
   - Contacting provider support

### ProviderCircuitBreakerOpen

**Alert**: Circuit breaker open for provider

**Response**:
1. Check what triggered the circuit breaker:
   ```bash
   kubectl logs -l app=orchestrator -n oss-ai | grep "circuit breaker" | grep <provider>
   ```
2. Review error patterns in the last 10 minutes
3. Test provider manually:
   ```bash
   curl -X POST https://api.<provider>.com/v1/test \
     -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json"
   ```
4. If provider is healthy:
   - Wait for automatic circuit breaker reset (default: 60s)
   - Or manually reset by restarting pods
5. If provider issues persist:
   - Update provider configuration to use fallback
   - Notify team of provider degradation

### AllProvidersDown

**Alert**: No successful requests to any provider

**Critical - Page On-Call**

**Response**:
1. **Immediate Actions**:
   ```bash
   # Check all provider health
   curl http://orchestrator:3000/health/providers
   
   # Check network connectivity
   kubectl exec -it deploy/orchestrator -n oss-ai -- ping -c 3 8.8.8.8
   
   # Review all provider configs
   kubectl get cm orchestrator-config -n oss-ai -o yaml
   ```

2. **Check Common Issues**:
   - Network policy blocking egress
   - DNS resolution issues
   - Proxy/firewall changes
   - Secret rotation failures

3. **Emergency Fallback**:
   ```bash
   # Scale up local Ollama provider
   kubectl scale deploy ollama --replicas=3 -n oss-ai
   
   # Update orchestrator to prefer local
   kubectl set env deploy/orchestrator PROVIDER_PREFERENCE=ollama -n oss-ai
   ```

### ProviderHighLatency

**Alert**: P95 latency >5s for 10 minutes

**Response**:
1. Check provider-specific latency:
   ```bash
   # Query Prometheus
   histogram_quantile(0.95, 
     sum(rate(orchestrator_provider_latency_seconds_bucket[5m])) by (provider, le)
   )
   ```
2. Review request patterns:
   - Token count per request
   - Model complexity
   - Batch sizes
3. Optimization options:
   - Enable request batching
   - Increase timeout values
   - Switch to faster model variant
   - Add caching layer

### ProviderTokenUsageSpike

**Alert**: Token usage 3x higher than hourly average

**Response**:
1. Identify source of spike:
   ```bash
   # Top users by token usage
   sum(rate(orchestrator_provider_tokens_total[5m])) by (tenant_id, user_id)
   ```
2. Review recent large requests:
   ```bash
   kubectl logs -l app=orchestrator -n oss-ai | grep "tokens" | sort -k5 -n | tail -20
   ```
3. Check for:
   - Infinite loops in agent logic
   - Unusually large context windows
   - Potential abuse/misconfiguration
4. Mitigation:
   - Apply rate limiting per user
   - Set max token limits
   - Contact users with abnormal usage

---

## Troubleshooting Guide

### Provider Not Receiving Requests

**Symptoms**: Provider metrics show 0 requests but was previously active

**Diagnosis**:
```bash
# Check provider configuration
kubectl get cm orchestrator-config -n oss-ai -o jsonpath='{.data.providers\.json}'

# Verify provider is enabled
curl http://orchestrator:3000/health/providers | jq '.providers.<provider>'

# Check circuit breaker state
curl http://orchestrator:3000/metrics | grep circuit_breaker | grep <provider>
```

**Solutions**:
1. Verify provider is in enabled list
2. Check circuit breaker isn't permanently open
3. Ensure credentials are valid
4. Review provider selection logic

### High Cache Miss Rate

**Symptoms**: Cache hit rate <30%

**Diagnosis**:
```bash
# Calculate cache hit rate
sum(rate(orchestrator_provider_cache_hits_total[5m])) / 
  (sum(rate(orchestrator_provider_cache_hits_total[5m])) + 
   sum(rate(orchestrator_provider_cache_misses_total[5m])))
```

**Solutions**:
1. Increase cache TTL:
   ```yaml
   orchestrator:
     cache:
       ttl: 3600  # 1 hour
   ```
2. Increase cache size:
   ```yaml
   orchestrator:
     cache:
       maxSize: 10000
   ```
3. Review cache key generation
4. Analyze request patterns for cacheability

### Provider Authentication Failures

**Symptoms**: 401/403 errors from provider

**Diagnosis**:
```bash
# Check secret values (without exposing)
kubectl get secret orchestrator-secrets -n oss-ai -o jsonpath='{.data}' | base64 -d | wc -c

# Test authentication
kubectl exec -it deploy/orchestrator -n oss-ai -- env | grep PROVIDER
```

**Solutions**:
1. Rotate API keys:
   ```bash
   kubectl create secret generic orchestrator-secrets \
     --from-literal=OPENAI_API_KEY=$NEW_KEY \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
2. Verify API key permissions
3. Check IP allowlists
4. Review rate limits

---

## Performance Tuning

### Connection Pool Configuration

```yaml
orchestrator:
  providers:
    connectionPool:
      maxConnections: 100
      maxIdleConnections: 10
      connectionTimeout: 30s
      idleTimeout: 90s
```

### Request Batching

```yaml
orchestrator:
  providers:
    batching:
      enabled: true
      maxBatchSize: 10
      batchTimeout: 100ms
```

### Circuit Breaker Tuning

```yaml
orchestrator:
  providers:
    circuitBreaker:
      threshold: 5           # failures before opening
      timeout: 60s           # time before attempting reset
      halfOpenRequests: 3    # test requests in half-open state
```

### Caching Strategy

```yaml
orchestrator:
  cache:
    enabled: true
    type: redis
    ttl: 3600
    maxSize: 10000
    compressionEnabled: true
```

---

## Maintenance Procedures

### Provider Credential Rotation

1. Generate new API keys from provider console
2. Update Kubernetes secret:
   ```bash
   kubectl create secret generic orchestrator-secrets \
     --from-literal=<PROVIDER>_API_KEY=$NEW_KEY \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Restart orchestrator pods:
   ```bash
   kubectl rollout restart deploy/orchestrator -n oss-ai
   ```
4. Verify provider health:
   ```bash
   curl http://orchestrator:3000/health/providers
   ```

### Adding New Provider

1. Update configuration:
   ```yaml
   providers:
     newProvider:
       enabled: true
       apiKey: ${NEW_PROVIDER_API_KEY}
       model: "model-name"
       timeout: 30s
   ```

2. Add metrics mapping:
   ```yaml
   metrics:
     providers:
       newProvider:
         requestsTotal: orchestrator_provider_requests_total
         latency: orchestrator_provider_latency_seconds
   ```

3. Deploy and verify:
   ```bash
   helm upgrade oss-ai-agent-tool ./charts/oss-ai-agent-tool
   kubectl logs -l app=orchestrator -n oss-ai | grep "newProvider"
   ```

### Provider Deprecation

1. Update provider preference order
2. Monitor traffic shift:
   ```bash
   sum(rate(orchestrator_provider_requests_total[5m])) by (provider)
   ```
3. After traffic reaches 0:
   - Remove provider configuration
   - Clean up secrets
   - Update documentation

---

## Appendix

### Useful Prometheus Queries

```promql
# Provider success rate
1 - (rate(orchestrator_provider_requests_total{status="error"}[5m]) / 
     rate(orchestrator_provider_requests_total[5m]))

# Token usage by model
sum(rate(orchestrator_provider_tokens_total[1h])) by (model)

# Cost projection (monthly)
sum(rate(orchestrator_provider_cost_dollars_total[1h]) * 730) by (provider)

# Circuit breaker flapping
changes(orchestrator_provider_circuit_breaker_state[30m])

# Request distribution
sum(rate(orchestrator_provider_requests_total[5m])) by (provider) / 
  ignoring(provider) group_left sum(rate(orchestrator_provider_requests_total[5m]))
```

### Emergency Contacts

- **Provider Status Pages**:
  - OpenAI: https://status.openai.com
  - Anthropic: https://status.anthropic.com
  - Google Cloud: https://status.cloud.google.com
  - Azure: https://status.azure.com

- **Internal Escalation**:
  - On-Call: PagerDuty
  - Slack: #oss-ai-incidents
  - Email: ai-platform@company.com

---

**Last Updated**: January 2025
**Version**: 1.0.0
**Owner**: Platform Engineering Team