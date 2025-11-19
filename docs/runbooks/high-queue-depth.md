# Runbook: High Queue Depth / Lag

## Alert Description

**Alert:** `QueueDepthHigh` or `QueueDepthCritical` or `KafkaLagHigh`

**Severity:** Warning (> 100 messages) / Critical (> 500 messages)

**Description:** Message queue depth or Kafka consumer lag has exceeded threshold, indicating processing backlog.

## Impact

- Increased end-to-end latency for plan execution
- Potential memory pressure on message broker
- Risk of message loss if broker runs out of disk space
- User-visible delays in plan completion

## Diagnosis

### 1. Check current queue metrics

```bash
# Get current queue depth from Prometheus
kubectl port-forward -n monitoring svc/prometheus 9090:9090

# Query in Prometheus UI:
orchestrator_queue_depth{queue="plan.steps"}
orchestrator_queue_lag{queue="plan.steps"}
orchestrator_queue_partition_lag
```

### 2. Identify which queues are affected

```bash
# For RabbitMQ
kubectl exec -it <rabbitmq-pod> -n <namespace> -- rabbitmqctl list_queues name messages consumers

# For Kafka
kubectl exec -it <kafka-pod> -n <namespace> -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group orchestrator-plan-runtime
```

### 3. Check consumer health

```bash
# Verify orchestrator pods are running
kubectl get pods -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace>

# Check for crashloops or restarts
kubectl describe pod <orchestrator-pod> -n <namespace>

# Review recent logs for errors
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator -n <namespace> --tail=100
```

### 4. Check HPA status

```bash
# Verify HPA is enabled and functioning
kubectl get hpa -n <namespace>

# Check HPA events
kubectl describe hpa oss-ai-agent-tool-orchestrator -n <namespace>

# Verify current/desired replicas
kubectl get deployment oss-ai-agent-tool-orchestrator -n <namespace>
```

### 5. Review processing performance metrics

```bash
# Check message processing duration
orchestrator_message_processing_duration_seconds

# Check error rates
rate(orchestrator_messages_failed_total[5m])

# Check dead letter queue depth
orchestrator_queue_depth{queue="plan.steps.dead"}
```

## Resolution Steps

### Scenario 1: HPA not scaling up

**Root cause:** HPA disabled, metrics unavailable, or at max replicas

**Solution:**

```bash
# 1. Verify HPA configuration
kubectl get hpa oss-ai-agent-tool-orchestrator -n <namespace> -o yaml

# 2. Check if at max replicas
# If current replicas == max replicas, increase max:
kubectl patch hpa oss-ai-agent-tool-orchestrator -n <namespace> \
  --type=merge -p '{"spec":{"maxReplicas":20}}'

# 3. Verify metrics are available
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1 | jq .

# 4. If metrics missing, check metrics server
kubectl get pods -n kube-system -l k8s-app=metrics-server
```

### Scenario 2: Consumer processing slowly

**Root cause:** Slow downstream dependencies (LLM providers, tools, database)

**Solution:**

```bash
# 1. Check processing duration trends in Grafana
# Look for P95/P99 latency spikes

# 2. Identify slow operations in traces
# Open Jaeger UI and filter by high-duration spans

# 3. If LLM provider is slow:
# - Check provider status page
# - Consider switching to faster model
# - Implement timeout reductions

# 4. If database is slow:
# - Check PostgreSQL metrics
# - Review slow query log
# - Consider connection pool tuning
```

### Scenario 3: High error rate

**Root cause:** Failing message processing causing retries

**Solution:**

```bash
# 1. Check dead letter queue
kubectl logs -l app.kubernetes.io/name=oss-ai-orchestrator \
  -n <namespace> --tail=1000 | grep -i "dead"

# 2. Sample a failed message
# Review orchestrator logs for error details

# 3. If transient errors (network, timeouts):
# - Check retry configuration
# - Verify circuit breaker thresholds
# - Consider increasing timeouts

# 4. If persistent errors (validation, auth):
# - Review recent code/config changes
# - Check provider credentials
# - Verify schema compatibility
```

### Scenario 4: Traffic spike

**Root cause:** Legitimate increase in workload

**Solution:**

```bash
# 1. Verify it's legitimate traffic
# Review audit logs and user activity

# 2. Scale horizontally
kubectl scale deployment oss-ai-agent-tool-orchestrator \
  -n <namespace> --replicas=<desired-count>

# 3. Adjust HPA for future spikes
kubectl patch hpa oss-ai-agent-tool-orchestrator -n <namespace> \
  --type=merge -p '{"spec":{"minReplicas":5,"maxReplicas":20}}'

# 4. Consider increasing resource limits
# Edit values.yaml:
# orchestrator.resources.limits.cpu: "2"
# orchestrator.resources.limits.memory: "1Gi"
```

## Temporary Mitigation

If immediate relief is needed before root cause resolution:

```bash
# Emergency horizontal scaling
kubectl scale deployment oss-ai-agent-tool-orchestrator \
  -n <namespace> --replicas=15

# Increase consumer concurrency (if supported)
kubectl set env deployment/oss-ai-agent-tool-orchestrator \
  -n <namespace> CONSUMER_CONCURRENCY=10
```

## Verification

After implementing fixes:

1. **Monitor queue depth trend** - Should decrease over 5-10 minutes
2. **Check consumer lag** - Should approach zero
3. **Verify no error spikes** - Error rate should remain low
4. **Confirm HPA behavior** - Replicas should scale appropriately

```bash
# Watch queue depth in real-time
watch -n 5 'kubectl exec -it <rabbitmq-pod> -n <namespace> -- \
  rabbitmqctl list_queues name messages consumers'
```

## Prevention

1. **Tune HPA thresholds** - Set `targetQueueDepth` based on normal load
2. **Implement rate limiting** - Protect against traffic spikes
3. **Right-size resources** - Ensure adequate CPU/memory for consumers
4. **Monitor trends** - Set up alerts for gradual queue depth increases
5. **Load testing** - Use `hpa-load-test.ts` to validate scaling behavior

## Related Alerts

- `ProcessingSlowdown` - Processing duration exceeds threshold
- `DeadLetterQueueHigh` - Messages failing repeatedly
- `HpaMaxReplicas` - At maximum scale, can't scale further
- `MessageSLOViolation` - Success rate below target

## References

- [HPA Load Testing Guide](../../services/orchestrator/scripts/HPA_LOAD_TEST_README.md)
- [values.yaml HPA configuration](../../charts/oss-ai-agent-tool/values.yaml#orchestrator.hpa)
- [Prometheus alerts](../../charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml)
