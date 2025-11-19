# HPA Load Testing Guide

This guide explains how to use the HPA load testing script to validate autoscaling behavior for the OSS AI Agent Tool orchestrator.

## Overview

The `hpa-load-test.ts` script generates configurable message loads on queues and monitors HPA scaling decisions in real-time. It validates:

- Scale-up behavior when queue depth/lag exceeds targets
- Scale-down behavior during cooldown periods
- Time-to-scale metrics
- HPA effectiveness and stability

## Prerequisites

1. **Kubernetes cluster** with metrics-server installed
2. **Prometheus** configured to scrape orchestrator metrics
3. **HPA configured** for the orchestrator deployment
4. **Queue backend** (Kafka or RabbitMQ) running and accessible

## Quick Start

### Test Kafka HPA with Basic Load

```bash
cd services/orchestrator
tsx scripts/hpa-load-test.ts \
  --transport=kafka \
  --messages=100 \
  --ramp-up=30 \
  --queue=plan.steps
```

### Test RabbitMQ HPA with Sustained Load

```bash
tsx scripts/hpa-load-test.ts \
  --transport=rabbitmq \
  --messages=500 \
  --ramp-up=60 \
  --sustained=120 \
  --queue=plan.steps
```

### Test Scale-Down Behavior

```bash
tsx scripts/hpa-load-test.ts \
  --transport=kafka \
  --messages=200 \
  --ramp-up=30 \
  --cooldown=300 \
  --target-depth=5
```

## Command-Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--transport` | Queue transport (`kafka` or `rabbitmq`) | `kafka` |
| `--queue` | Queue name to test | `plan.steps` |
| `--messages` | Total messages to enqueue during ramp-up | `100` |
| `--ramp-up` | Ramp-up duration in seconds | `30` |
| `--sustained` | Sustained load duration (0 = skip) | `0` |
| `--cooldown` | Cooldown observation duration | `60` |
| `--target-depth` | HPA target queue depth per pod | `5` |
| `--min-replicas` | HPA minimum replicas | `2` |
| `--max-replicas` | HPA maximum replicas | `10` |
| `--payload-size` | Message payload size in bytes | `1024` |
| `--batch-size` | Messages per enqueue batch | `10` |

## Test Phases

### Phase 1: Ramp-Up

- Enqueues messages at a controlled rate over the ramp-up period
- Monitors queue depth/lag increasing
- Observes HPA scale-up decisions

**Expected Behavior:**
- Queue depth should increase steadily
- HPA should trigger scale-up when depth exceeds `targetDepth`
- Replicas should increase from `minReplicas` toward `maxReplicas`

### Phase 2: Sustained Load (Optional)

- Maintains queue depth around the target by continuous enqueueing
- Validates HPA stability at scale
- Tests steady-state behavior

**Expected Behavior:**
- Queue depth should stabilize near the target
- Replica count should remain stable
- No thrashing (rapid scale-up/scale-down cycles)

### Phase 3: Cooldown

- Stops enqueueing new messages
- Observes queue drain and scale-down
- Measures scale-down delay (cooldown period)

**Expected Behavior:**
- Queue depth should decrease as messages are processed
- HPA should trigger scale-down after cooldown period
- Replicas should decrease toward `minReplicas`

## Analyzing Results

### Queue Depth Metrics

The script reports:
- **Average depth:** Mean queue depth during test
- **Max depth:** Peak queue depth (should not exceed target by more than 3x)
- **Min depth:** Minimum queue depth

**Good Result:** Average depth near target, max depth < 3x target

### Scaling Events

Reports all detected scaling events with:
- Timestamp
- Scale direction (up/down)
- Replica count
- Queue depth/lag at event

**Good Result:** 
- Scale-up within 30-60s of load increase
- Scale-down after appropriate cooldown (5-10 minutes)
- Smooth transitions without thrashing

### HPA Effectiveness

Percentage of time queue depth was within acceptable range:
- Within ±20% of target = effective
- >20% above target = under-scaled
- >50% below target = over-scaled

**Good Result:** >70% effectiveness

## Example Output

```
=== Load Test Results ===

Queue Depth Metrics:
  Average: 8.45
  Max: 35
  Min: 0
  Target: 5

Queue Lag Metrics:
  Average: 8.45
  Max: 35

Scaling Events:
  15.2s: scale-up to 4 replicas (depth=28, lag=28)
  45.8s: scale-up to 7 replicas (depth=35, lag=35)
  180.3s: scale-down to 4 replicas (depth=12, lag=12)
  300.7s: scale-down to 2 replicas (depth=1, lag=1)

Time to first scale-up: 15.2s
Scale-down cooldown time: 135.1s

HPA Effectiveness:
  Within target range: 78.5%
  Samples above target (+20%): 12
  Samples below target (-50%): 8

Recommendations:
  ✓ HPA configuration appears optimal
```

## Monitoring HPA in Real-Time

While running the load test, monitor HPA status:

```bash
# Watch HPA status
kubectl get hpa -n oss-ai-agent-tool -w

# Watch pod scaling
kubectl get pods -n oss-ai-agent-tool -l app=orchestrator -w

# Query Prometheus metrics
curl -g 'http://prometheus:9090/api/v1/query?query=orchestrator_queue_depth{queue="plan.steps"}'
```

## Troubleshooting

### No Scaling Events Detected

**Possible Causes:**
- HPA target is too high relative to message load
- Metrics server not scraping orchestrator metrics
- HPA not configured correctly

**Solutions:**
- Increase `--messages` or decrease `--target-depth`
- Verify metrics endpoint: `kubectl port-forward svc/orchestrator 8080:8080` then `curl http://localhost:8080/metrics`
- Check HPA status: `kubectl describe hpa orchestrator`

### Rapid Thrashing (Frequent Scale Up/Down)

**Possible Causes:**
- HPA target too sensitive
- Cooldown period too short
- Message processing too fast

**Solutions:**
- Increase `--target-depth` to reduce sensitivity
- Increase HPA `scaleDownStabilizationWindowSeconds` (default 300s)
- Increase `--sustained` duration to test stability

### Scale-Up Too Slow

**Possible Causes:**
- HPA evaluation interval too long (default 15s)
- Metrics scraping interval too long
- Insufficient resources for pod startup

**Solutions:**
- Tune HPA `--horizontal-pod-autoscaler-sync-period` (default 15s)
- Check Prometheus scrape interval (should be ≤15s)
- Pre-warm pod images: `kubectl rollout restart deployment/orchestrator`

### Kafka Partition Lag Not Decreasing

**Possible Causes:**
- Partition count < replica count (some replicas idle)
- Consumer group rebalancing
- Uneven partition distribution

**Solutions:**
- Increase Kafka topic partition count to match or exceed max replicas
- Monitor partition lag: script shows `partitionLag` breakdown
- Review consumer group assignments

## Advanced Scenarios

### Testing Multi-Queue HPA

Test multiple queues with independent HPA configurations:

```bash
# Terminal 1: Load test plan.steps
tsx scripts/hpa-load-test.ts --queue=plan.steps --messages=200

# Terminal 2: Load test plan.completions
tsx scripts/hpa-load-test.ts --queue=plan.completions --messages=100

# Terminal 3: Monitor both HPAs
watch -n 2 'kubectl get hpa -n oss-ai-agent-tool'
```

### Testing Peak Traffic

Simulate burst traffic patterns:

```bash
# Burst: 1000 messages in 10 seconds, observe recovery
tsx scripts/hpa-load-test.ts \
  --messages=1000 \
  --ramp-up=10 \
  --cooldown=600 \
  --max-replicas=20
```

### Testing Scale-Down Policies

Validate aggressive vs. conservative scale-down:

```bash
# Conservative (long cooldown)
tsx scripts/hpa-load-test.ts \
  --messages=500 \
  --ramp-up=60 \
  --cooldown=600

# Aggressive (short cooldown) - requires HPA tuning
tsx scripts/hpa-load-test.ts \
  --messages=500 \
  --ramp-up=60 \
  --cooldown=180
```

## Integration with CI/CD

Add to your pipeline to validate HPA before production:

```yaml
# .github/workflows/hpa-test.yml
name: HPA Integration Test

on:
  pull_request:
    paths:
      - 'charts/oss-ai-agent-tool/templates/orchestrator-hpa.yaml'
      - 'services/orchestrator/src/queue/**'

jobs:
  hpa-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup k8s cluster
        uses: helm/kind-action@v1
        
      - name: Deploy with Helm
        run: |
          helm install oss-ai-agent-tool ./charts/oss-ai-agent-tool \
            --set orchestrator.hpa.enabled=true \
            --set orchestrator.hpa.targetQueueDepth=5
            
      - name: Run HPA load test
        run: |
          cd services/orchestrator
          npm install
          tsx scripts/hpa-load-test.ts \
            --messages=100 \
            --ramp-up=30 \
            --cooldown=120
            
      - name: Validate results
        run: |
          # Check that scaling occurred
          kubectl get hpa -n oss-ai-agent-tool -o json | \
            jq '.items[0].status.currentReplicas > .items[0].spec.minReplicas'
```

## Best Practices

1. **Start Small:** Begin with low message counts to validate basic HPA functionality
2. **Monitor Costs:** Large-scale tests can spin up many pods - set appropriate `maxReplicas`
3. **Realistic Payloads:** Use `--payload-size` matching production workloads
4. **Multiple Runs:** Execute tests multiple times to account for variance
5. **Clean Up:** Ensure queues are drained after tests to avoid residual load

## See Also

- [Kubernetes HPA Documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Prometheus Adapter Configuration](https://github.com/kubernetes-sigs/prometheus-adapter)
- [Queue Metrics Documentation](../../docs/observability/metrics.md)
