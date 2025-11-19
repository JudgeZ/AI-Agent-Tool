# Metrics Reference Guide

## Overview

This document provides a comprehensive reference for all metrics exposed by the OSS-AI-Agent-Tool orchestrator service, including provider metrics, queue metrics, and system metrics.

## Provider Metrics

### orchestrator_provider_requests_total

**Type**: Counter  
**Description**: Total number of requests to AI providers  
**Labels**:
- `provider`: Provider name (openai, anthropic, google, etc.)
- `model`: Model identifier
- `status`: Request status (success, error)
- `error_type`: Type of error (timeout, rate_limit, auth, network, etc.)
- `tenant_id`: Tenant identifier
- `namespace`: Kubernetes namespace

**Example**:
```promql
# Success rate by provider
1 - (rate(orchestrator_provider_requests_total{status="error"}[5m]) / 
     rate(orchestrator_provider_requests_total[5m]))
```

### orchestrator_provider_latency_seconds

**Type**: Histogram  
**Description**: Request latency to AI providers in seconds  
**Buckets**: 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier
- `operation`: Operation type (completion, chat, embedding)
- `tenant_id`: Tenant identifier

**Example**:
```promql
# P95 latency by provider
histogram_quantile(0.95, 
  sum(rate(orchestrator_provider_latency_seconds_bucket[5m])) by (provider, le)
)
```

### orchestrator_provider_tokens_total

**Type**: Counter  
**Description**: Total tokens processed  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier
- `type`: Token type (prompt, completion, total)
- `tenant_id`: Tenant identifier

**Example**:
```promql
# Token usage rate per hour
sum(rate(orchestrator_provider_tokens_total[1h]) * 3600) by (model)
```

### orchestrator_provider_cost_dollars_total

**Type**: Counter  
**Description**: Cumulative cost in USD  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier
- `tenant_id`: Tenant identifier
- `cost_type`: Type of cost (prompt, completion, request)

**Example**:
```promql
# Monthly cost projection
sum(rate(orchestrator_provider_cost_dollars_total[1d]) * 30) by (provider)
```

### orchestrator_provider_retries_total

**Type**: Counter  
**Description**: Total number of request retries  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier
- `retry_reason`: Reason for retry (timeout, rate_limit, error_500)

**Example**:
```promql
# Retry rate
rate(orchestrator_provider_retries_total[5m]) / 
  rate(orchestrator_provider_requests_total[5m])
```

### orchestrator_provider_timeouts_total

**Type**: Counter  
**Description**: Total number of request timeouts  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier
- `timeout_type`: Type of timeout (connection, read, total)

### orchestrator_provider_circuit_breaker_state

**Type**: Gauge  
**Description**: Circuit breaker state (0=closed, 0.5=half-open, 1=open)  
**Labels**:
- `provider`: Provider name
- `state`: State name (closed, half_open, open)

### orchestrator_provider_circuit_breaker_transitions_total

**Type**: Counter  
**Description**: Circuit breaker state transitions  
**Labels**:
- `provider`: Provider name
- `from_state`: Previous state
- `to_state`: New state

### orchestrator_provider_cache_hits_total

**Type**: Counter  
**Description**: Cache hit count  
**Labels**:
- `provider`: Provider name
- `cache_type`: Type of cache (response, embedding, completion)

### orchestrator_provider_cache_misses_total

**Type**: Counter  
**Description**: Cache miss count  
**Labels**:
- `provider`: Provider name
- `cache_type`: Type of cache

### orchestrator_provider_health_status

**Type**: Gauge  
**Description**: Provider health status (0=unhealthy, 1=healthy)  
**Labels**:
- `provider`: Provider name
- `check_type`: Type of health check (api, auth, network)

### orchestrator_provider_active_requests

**Type**: Gauge  
**Description**: Currently active requests to provider  
**Labels**:
- `provider`: Provider name
- `model`: Model identifier

## Queue Metrics

### orchestrator_queue_depth

**Type**: Gauge  
**Description**: Current queue depth (messages waiting)  
**Labels**:
- `queue`: Queue name (plan.steps, plan.completions, etc.)
- `transport`: Transport type (kafka, rabbitmq)
- `partition`: Partition number (Kafka only)

### orchestrator_queue_lag

**Type**: Gauge  
**Description**: Consumer lag (Kafka only)  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type
- `consumer_group`: Consumer group name
- `partition`: Partition number

### orchestrator_queue_processing_seconds

**Type**: Histogram  
**Description**: Message processing time  
**Buckets**: 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type
- `result`: Processing result (success, error, retry)

### orchestrator_queue_acks_total

**Type**: Counter  
**Description**: Messages successfully processed  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type

### orchestrator_queue_nacks_total

**Type**: Counter  
**Description**: Messages rejected (negative acknowledgment)  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type
- `reason`: Rejection reason

### orchestrator_queue_retries_total

**Type**: Counter  
**Description**: Message retry attempts  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type

### orchestrator_queue_dead_letters_total

**Type**: Counter  
**Description**: Messages sent to dead letter queue  
**Labels**:
- `queue`: Queue name
- `transport`: Transport type
- `reason`: Dead letter reason

## Alert Thresholds

### Provider Alerts

| Alert | Condition | Duration | Severity |
|-------|-----------|----------|----------|
| ProviderHighErrorRate | Error rate > 5% | 5m | warning |
| ProviderDown | No requests for 5m (was active) | 5m | critical |
| AllProvidersDown | No successful requests | 2m | critical/page |
| ProviderHighLatency | P95 > 5s | 10m | warning |
| ProviderTimeoutRate | Timeout rate > 1% | 5m | warning |
| ProviderCircuitBreakerOpen | Circuit open | 1m | warning |
| MultipleCircuitBreakersOpen | ≥2 circuits open | 2m | critical |
| ProviderHighRetryRate | Retry rate > 10% | 10m | warning |
| ProviderTokenUsageSpike | 3x normal usage | 5m | warning |
| ProviderCostRateHigh | >$1000/month projection | 15m | warning |
| ProviderCacheHitRateLow | <30% hit rate | 30m | info |
| ProviderHealthCheckFailing | Health check failing | 3m | warning |

### Queue Alerts

| Alert | Condition | Duration | Severity |
|-------|-----------|----------|----------|
| QueueDepthHigh | >100 messages | 5m | warning |
| QueueDepthCritical | >500 messages | 2m | critical |
| KafkaConsumerLagHigh | >100 message lag | 5m | warning |
| KafkaPartitionLagImbalanced | >50 message variance | 10m | warning |
| QueueProcessingSlowdown | Avg >30s | 10m | warning |
| HighDeadLetterRate | >1 msg/sec | 5m | warning |
| HighRetryRate | >20% retry rate | 10m | warning |

### HPA Alerts

| Alert | Condition | Duration | Severity |
|-------|-----------|----------|----------|
| HPAAtMaxReplicas | At max with high queue | 10m | warning |
| HPAScalingDisabled | Scaling not active | 5m | critical |
| HPAMetricsMissing | Required metrics absent | 5m | critical |
| HPACPUThresholdExceeded | CPU > 80% | 5m | warning |
| HPAMemoryThresholdExceeded | Memory > 80% | 5m | warning |
| HPAFrequentScaling | >10 changes in 30m | 5m | warning |

### SLO Alerts

| Alert | Condition | Duration | Severity |
|-------|-----------|----------|----------|
| MessageProcessingSLOViolation | Success rate < 99% | 10m | warning |
| QueueProcessingLatencySLOViolation | P95 > 60s | 10m | warning |
| ProviderAvailabilitySLOViolation | Availability < 99.5% | 15m | warning |
| ProviderLatencySLOViolation | P99 > 10s | 15m | warning |

## Metric Collection Best Practices

### Cardinality Management

**High Cardinality Labels to Avoid**:
- User IDs (use tenant_id instead)
- Request IDs
- Timestamps
- Full error messages

**Recommended Cardinality Limits**:
- Provider: ~10 unique values
- Model: ~50 unique values
- Error types: ~20 unique values
- Tenant IDs: <1000 unique values

### Sampling Rates

For high-volume metrics, consider sampling:

```yaml
orchestrator:
  metrics:
    sampling:
      enabled: true
      rate: 0.1  # Sample 10% of requests
      always_sample_errors: true
```

### Retention Policies

Recommended Prometheus retention:

| Metric Type | Resolution | Retention |
|-------------|------------|-----------|
| Request rates | 15s | 1 day |
| Request rates | 1m | 7 days |
| Request rates | 5m | 30 days |
| Cost metrics | 1h | 90 days |
| SLO metrics | 5m | 90 days |

### Aggregation Rules

Example recording rules for Prometheus:

```yaml
groups:
  - name: provider_aggregations
    interval: 30s
    rules:
      - record: provider:requests:rate5m
        expr: |
          sum(rate(orchestrator_provider_requests_total[5m])) by (provider)
      
      - record: provider:error_rate:rate5m
        expr: |
          sum(rate(orchestrator_provider_requests_total{status="error"}[5m])) by (provider) /
          sum(rate(orchestrator_provider_requests_total[5m])) by (provider)
      
      - record: provider:p95_latency:5m
        expr: |
          histogram_quantile(0.95,
            sum(rate(orchestrator_provider_latency_seconds_bucket[5m])) by (provider, le)
          )
```

## Grafana Dashboard Variables

Recommended dashboard variables:

```json
{
  "datasource": {
    "type": "datasource",
    "query": "prometheus"
  },
  "namespace": {
    "type": "query",
    "query": "label_values(namespace)"
  },
  "provider": {
    "type": "query",
    "query": "label_values(orchestrator_provider_requests_total, provider)",
    "multi": true,
    "includeAll": true
  },
  "model": {
    "type": "query",
    "query": "label_values(orchestrator_provider_requests_total{provider=~\"$provider\"}, model)",
    "multi": true,
    "includeAll": true
  },
  "interval": {
    "type": "interval",
    "values": ["1m", "5m", "15m", "1h", "6h", "12h", "1d"]
  }
}
```

## Troubleshooting Metrics

### Missing Metrics

```bash
# Check if metrics endpoint is accessible
curl http://orchestrator:3000/metrics

# Verify specific metric exists
curl http://orchestrator:3000/metrics | grep orchestrator_provider

# Check Prometheus targets
curl http://prometheus:9090/api/v1/targets
```

### High Cardinality Issues

```promql
# Find high cardinality metrics
count by (__name__)({__name__=~"orchestrator_.*"})

# Check label cardinality
count(count by (tenant_id)(orchestrator_provider_requests_total))
```

### Metric Calculation Examples

```promql
# Error budget remaining (30-day window)
1 - (
  sum(increase(orchestrator_provider_requests_total{status="error"}[30d])) /
  sum(increase(orchestrator_provider_requests_total[30d]))
)

# Cost per request
sum(rate(orchestrator_provider_cost_dollars_total[1h])) /
sum(rate(orchestrator_provider_requests_total[1h]))

# Token efficiency (tokens per dollar)
sum(rate(orchestrator_provider_tokens_total[1h])) /
sum(rate(orchestrator_provider_cost_dollars_total[1h]))
```

---

**Last Updated**: January 2025  
**Version**: 1.0.0  
**Maintained By**: Platform Engineering Team