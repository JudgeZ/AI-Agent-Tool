# Queue Runtime System

This directory contains the queue runtime system for the OSS AI Agent Tool orchestrator. The queue system enables asynchronous plan execution, horizontal scaling, and reliable message processing with retry and dead-letter handling.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     PlanQueueRuntime                            │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Queue Adapter (RabbitMQ or Kafka)                        │ │
│  │  - Enqueue plans                                          │ │
│  │  - Consume messages                                       │ │
│  │  - Retry logic                                            │ │
│  │  - Dead-letter handling                                   │ │
│  └───────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  PlanStateStore (File or PostgreSQL)                      │ │
│  │  - Persist plan state                                     │ │
│  │  - Track execution progress                               │ │
│  │  - Enable resume/retry                                    │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### QueueAdapter (Interface)

The `QueueAdapter` interface defines the contract for queue implementations:

```typescript
interface QueueAdapter {
  enqueue(planId: string, payload: unknown): Promise<void>;
  consume(handler: (planId: string, payload: unknown) => Promise<void>): Promise<void>;
  ack(planId: string): Promise<void>;
  nack(planId: string, requeue: boolean): Promise<void>;
  close(): Promise<void>;
}
```

### RabbitMQAdapter

**When to use:**
- **Small to medium scale** (< 100k messages/day)
- **Low latency requirements** (< 100ms message delivery)
- **Simple deployment** (single broker for dev/staging)
- **Strong message ordering** within a single queue
- **Traditional request/response patterns**

**Features:**
- Prefetch control (default: 1) for fair work distribution
- Automatic reconnection with exponential backoff
- Dead-letter exchange for failed messages
- Message persistence (durable queues)
- Consumer acknowledgments (manual ack/nack)
- Retry with exponential backoff (max 5 retries)

**Configuration:**
```typescript
const adapter = new RabbitMQAdapter({
  url: "amqp://localhost:5672",
  queue: "plans",
  prefetch: 1,
  retryDelay: 5000,
  maxRetries: 5,
  deadLetterExchange: "plans.dlx"
});
```

**Metrics emitted:**
- `queue_depth` (gauge) - Current number of messages in queue
- `queue_enqueue_total` (counter) - Total messages enqueued
- `queue_consume_total` (counter) - Total messages consumed
- `queue_ack_total` (counter) - Total messages acknowledged
- `queue_nack_total` (counter) - Total messages negatively acknowledged
- `queue_retry_total` (counter) - Total retry attempts
- `queue_dead_letter_total` (counter) - Messages sent to dead-letter queue
- `queue_operation_duration_seconds` (histogram) - Operation latency

**Retry behavior:**
- Failed messages are nacked with `requeue=false`
- Sent to dead-letter exchange (DLX)
- DLX routes to retry queue with TTL (time-to-live)
- After TTL expires, message returns to main queue
- Retry count tracked in message headers (`x-retry-count`)
- After `maxRetries`, message stays in dead-letter queue for manual inspection

**File reference:** `RabbitMQAdapter.ts:1-400`

### KafkaAdapter

**When to use:**
- **Large scale** (> 100k messages/day)
- **High throughput** (> 1k messages/second)
- **Event sourcing** or audit log requirements
- **Multiple consumers** reading same message stream
- **Long-term message retention** (days/weeks)
- **Horizontal scaling** with consumer groups

**Features:**
- Consumer group support for load balancing
- Automatic offset commits with retries
- SASL authentication (PLAIN, SCRAM-SHA-256, SCRAM-SHA-512)
- TLS/SSL encryption
- Topic compaction for plan state deduplication
- Configurable partitioning strategy
- Consumer lag metrics for HPA (Horizontal Pod Autoscaling)

**Configuration:**
```typescript
const adapter = new KafkaAdapter({
  brokers: ["localhost:9092"],
  topic: "plans",
  groupId: "orchestrator-consumers",
  clientId: "orchestrator-1",
  sasl: {
    mechanism: "scram-sha-256",
    username: "admin",
    password: "secret"
  },
  ssl: true,
  retryDelay: 5000,
  maxRetries: 5
});
```

**Metrics emitted:**
- `kafka_consumer_lag` (gauge) - Messages behind latest offset
- `kafka_partition_offset` (gauge) - Current consumer offset per partition
- `kafka_messages_consumed_total` (counter) - Total messages consumed
- `kafka_messages_produced_total` (counter) - Total messages produced
- `kafka_batch_size` (histogram) - Messages per consumer batch
- `kafka_operation_duration_seconds` (histogram) - Operation latency

**Retry behavior:**
- Failed messages are retried in-process (up to `maxRetries`)
- On exhaustion, offset is committed to skip poison message
- Failed messages logged to audit trail with plan ID and error
- No automatic dead-letter topic (configure via application logic)

**Consumer lag and HPA:**
The `kafka_consumer_lag` metric is crucial for Kubernetes HPA:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orchestrator-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orchestrator
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: External
    external:
      metric:
        name: kafka_consumer_lag
        selector:
          matchLabels:
            topic: plans
            group: orchestrator-consumers
      target:
        type: AverageValue
        averageValue: "1000"  # Scale up if lag > 1000/replica
```

**File reference:** `KafkaAdapter.ts:1-350`

### PlanStateStore

The `PlanStateStore` persists plan execution state for resume/retry and audit purposes.

**Backends:**

1. **File-based** (development/testing):
   ```typescript
   const store = new PlanStateStore({
     backend: "file",
     filePath: "./data/plan-state"
   });
   ```

2. **PostgreSQL** (production):
   ```typescript
   const store = new PlanStateStore({
     backend: "postgres",
     connectionString: "postgresql://user:pass@localhost/db"
   });
   ```

**Schema (PostgreSQL):**
```sql
CREATE TABLE plan_state (
  plan_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_step INTEGER,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plan_state_status ON plan_state(status);
CREATE INDEX idx_plan_state_updated_at ON plan_state(updated_at);
```

**State lifecycle:**
1. `pending` - Plan enqueued, not yet consumed
2. `running` - Consumer processing plan
3. `completed` - Plan finished successfully
4. `failed` - Plan failed after max retries
5. `cancelled` - Plan cancelled by user

**File reference:** `PlanStateStore.ts:1-250`

### PlanQueueRuntime

The `PlanQueueRuntime` orchestrates the queue adapter and state store:

```typescript
const runtime = new PlanQueueRuntime({
  adapter: new RabbitMQAdapter({ ... }),
  stateStore: new PlanStateStore({ ... }),
  planExecutor: async (planId, payload) => {
    // Execute plan logic
    await executePlan(planId, payload);
  }
});

await runtime.start();
```

**Features:**
- Automatic state persistence on enqueue/consume
- Graceful shutdown with pending message completion
- Error handling with state updates
- Metrics aggregation from adapter and state store

**File reference:** `PlanQueueRuntime.ts:1-200`

## RabbitMQ vs Kafka: Decision Guide

| Criteria | RabbitMQ | Kafka |
|----------|----------|-------|
| **Message volume** | < 100k/day | > 100k/day |
| **Latency requirement** | < 100ms | < 1s acceptable |
| **Message ordering** | Strong (per queue) | Strong (per partition) |
| **Message retention** | Short (hours) | Long (days/weeks) |
| **Consumer model** | Competing consumers | Consumer groups |
| **Operational complexity** | Low | Medium-High |
| **Message replay** | No | Yes |
| **Memory usage** | Low | High |
| **Disk usage** | Low | High |
| **Scaling** | Vertical (single broker) | Horizontal (multiple brokers) |
| **Use case** | Task queues, RPC | Event streaming, audit logs |

**Default recommendation:** Start with **RabbitMQ** for simplicity. Migrate to **Kafka** when:
- Message volume exceeds 50k/day consistently
- Consumer lag exceeds 10k messages regularly
- Event sourcing or audit replay is required
- Multiple independent consumers need same message stream

## Queue Depth Metrics

Both adapters emit `queue_depth` (RabbitMQ) or `kafka_consumer_lag` (Kafka) metrics for monitoring and autoscaling.

**Prometheus query examples:**

```promql
# Current queue depth (RabbitMQ)
queue_depth{queue="plans"}

# Consumer lag (Kafka)
kafka_consumer_lag{topic="plans", group="orchestrator-consumers"}

# Queue depth rate of change
rate(queue_depth{queue="plans"}[5m])

# Time to drain queue (estimated)
queue_depth{queue="plans"} / rate(queue_consume_total{queue="plans"}[5m])
```

**Alerting rules:**

```yaml
groups:
- name: queue_alerts
  rules:
  - alert: HighQueueDepth
    expr: queue_depth{queue="plans"} > 10000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High queue depth in {{ $labels.queue }}"
      description: "Queue depth is {{ $value }}, consider scaling consumers"

  - alert: QueueDepthCritical
    expr: queue_depth{queue="plans"} > 50000
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Critical queue depth in {{ $labels.queue }}"
      description: "Queue depth is {{ $value }}, immediate action required"

  - alert: HighConsumerLag
    expr: kafka_consumer_lag{topic="plans"} > 5000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High consumer lag in {{ $labels.topic }}"
      description: "Consumer lag is {{ $value }}, consider scaling"
```

## Retry and Dead-Letter Behavior

### RabbitMQ Dead-Letter Exchange (DLX)

**Setup:**
```typescript
// Main queue with DLX configured
await channel.assertQueue("plans", {
  durable: true,
  arguments: {
    "x-dead-letter-exchange": "plans.dlx",
    "x-dead-letter-routing-key": "plans.retry"
  }
});

// Dead-letter exchange
await channel.assertExchange("plans.dlx", "topic", { durable: true });

// Retry queue with TTL
await channel.assertQueue("plans.retry", {
  durable: true,
  arguments: {
    "x-message-ttl": 5000,  // 5 seconds
    "x-dead-letter-exchange": "",
    "x-dead-letter-routing-key": "plans"
  }
});

// Bind retry queue to DLX
await channel.bindQueue("plans.retry", "plans.dlx", "plans.retry");

// Final dead-letter queue (no TTL)
await channel.assertQueue("plans.dlq", { durable: true });
await channel.bindQueue("plans.dlq", "plans.dlx", "plans.dlq");
```

**Flow:**
1. Consumer fails to process message → `nack(planId, false)`
2. Message sent to `plans.dlx` exchange
3. Routed to `plans.retry` queue
4. After 5s TTL, message expires and returns to `plans` queue
5. If retry count < maxRetries, repeat steps 1-4
6. If retry count ≥ maxRetries, route to `plans.dlq` (final dead-letter queue)

**Monitoring dead-letter queue:**
```promql
queue_depth{queue="plans.dlq"} > 0
```

### Kafka Retry Strategy

Kafka doesn't have built-in DLX. Implement retry logic in application:

```typescript
async consume(handler: MessageHandler): Promise<void> {
  await this.consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const planId = message.key?.toString();
      const payload = JSON.parse(message.value?.toString() || "{}");
      const retryCount = parseInt(message.headers?.["retry-count"]?.toString() || "0");

      try {
        await handler(planId, payload);
        await this.consumer.commitOffsets([{
          topic,
          partition,
          offset: (parseInt(message.offset) + 1).toString()
        }]);
      } catch (error) {
        if (retryCount < this.maxRetries) {
          // Retry in-process with exponential backoff
          await this.delay(this.retryDelay * Math.pow(2, retryCount));
          // Produce to same topic with incremented retry count
          await this.producer.send({
            topic,
            messages: [{
              key: planId,
              value: JSON.stringify(payload),
              headers: { "retry-count": (retryCount + 1).toString() }
            }]
          });
          // Commit offset to skip original message
          await this.consumer.commitOffsets([{
            topic,
            partition,
            offset: (parseInt(message.offset) + 1).toString()
          }]);
        } else {
          // Max retries exceeded, log and commit
          logger.error({ planId, error }, "plan execution failed after max retries");
          await this.consumer.commitOffsets([{
            topic,
            partition,
            offset: (parseInt(message.offset) + 1).toString()
          }]);
        }
      }
    }
  });
}
```

**Alternative: Separate retry topic**
```typescript
// Produce failed messages to retry topic
await this.producer.send({
  topic: "plans.retry",
  messages: [{
    key: planId,
    value: JSON.stringify(payload),
    headers: {
      "retry-count": (retryCount + 1).toString(),
      "original-topic": "plans",
      "retry-at": (Date.now() + this.retryDelay).toString()
    }
  }]
});
```

## Testing

### Unit Tests

**RabbitMQAdapter:**
- `RabbitMQAdapter.test.ts` - Connection, enqueue, consume, ack/nack, reconnection
- 20+ test cases with testcontainers

**KafkaAdapter:**
- `KafkaAdapter.test.ts` - Producer, consumer, offset commits, SASL auth
- 15+ test cases with testcontainers

**PlanStateStore:**
- `PlanStateStore.test.ts` - File and PostgreSQL backends, state transitions
- 12+ test cases

### Integration Tests

**HPA Integration:**
- `HpaRabbitMQIntegration.test.ts` - Queue depth metrics for HPA
- `HpaKafkaIntegration.test.ts` - Consumer lag metrics for HPA

**Load Tests:**
See `services/orchestrator/scripts/hpa-load-test.ts` for load testing queue performance and HPA behavior.

## Best Practices

1. **Choose the right adapter:**
   - Start with RabbitMQ for simplicity
   - Migrate to Kafka when volume or retention requirements increase

2. **Monitor queue depth:**
   - Set up Prometheus alerts for high queue depth
   - Use HPA to automatically scale consumers

3. **Handle poison messages:**
   - Set reasonable `maxRetries` (3-5)
   - Monitor dead-letter queues
   - Implement manual inspection/replay for DLQ messages

4. **Configure persistence:**
   - Use PostgreSQL PlanStateStore in production
   - Set retention policy to purge old states (see `purge-expired-plan-states.ts`)

5. **Tune performance:**
   - RabbitMQ: Adjust `prefetch` based on message processing time
   - Kafka: Tune consumer `sessionTimeout` and `heartbeatInterval`

6. **Security:**
   - Enable SASL authentication (Kafka)
   - Use TLS/SSL for encryption in transit
   - Rotate credentials periodically

7. **Testing:**
   - Use testcontainers for integration tests
   - Test reconnection scenarios
   - Verify retry and dead-letter behavior

## Configuration Examples

### Development (RabbitMQ)

```typescript
const adapter = new RabbitMQAdapter({
  url: "amqp://localhost:5672",
  queue: "plans",
  prefetch: 1,
  retryDelay: 1000,
  maxRetries: 3
});

const stateStore = new PlanStateStore({
  backend: "file",
  filePath: "./data/plan-state"
});
```

### Production (Kafka + PostgreSQL)

```typescript
const adapter = new KafkaAdapter({
  brokers: process.env.KAFKA_BROKERS?.split(",") || [],
  topic: "plans",
  groupId: "orchestrator-consumers",
  clientId: process.env.HOSTNAME || "orchestrator",
  sasl: {
    mechanism: "scram-sha-256",
    username: process.env.KAFKA_USERNAME!,
    password: process.env.KAFKA_PASSWORD!
  },
  ssl: true,
  retryDelay: 5000,
  maxRetries: 5
});

const stateStore = new PlanStateStore({
  backend: "postgres",
  connectionString: process.env.DATABASE_URL!
});
```

## Troubleshooting

### RabbitMQ

**Issue:** Messages not being consumed
- Check consumer connection: `rabbitmqctl list_consumers`
- Verify queue exists: `rabbitmqctl list_queues`
- Check prefetch setting (too high = starvation, too low = underutilization)

**Issue:** Messages stuck in retry queue
- Check retry queue TTL: `rabbitmqctl list_queues name arguments`
- Verify DLX binding: `rabbitmqctl list_bindings`

**Issue:** High memory usage
- Check queue depth: `rabbitmqctl list_queues name messages`
- Purge old messages: `rabbitmqctl purge_queue plans.dlq`

### Kafka

**Issue:** High consumer lag
- Scale consumers horizontally (increase replicas)
- Check consumer processing time
- Verify no blocking calls in message handler

**Issue:** Consumer group rebalancing
- Increase `sessionTimeout` if processing time is high
- Check network stability
- Verify consumer heartbeats

**Issue:** Offset commit failures
- Check broker connectivity
- Verify SASL credentials
- Increase `commitInterval` to reduce commit frequency

## References

- **File structure:**
  - `QueueAdapter.ts` - Interface definition
  - `RabbitMQAdapter.ts` - RabbitMQ implementation
  - `KafkaAdapter.ts` - Kafka implementation
  - `PlanStateStore.ts` - State persistence
  - `PlanQueueRuntime.ts` - Orchestration layer

- **Tests:**
  - `__tests__/RabbitMQAdapter.test.ts`
  - `__tests__/KafkaAdapter.test.ts`
  - `__tests__/PlanStateStore.test.ts`
  - `__tests__/HpaRabbitMQIntegration.test.ts`
  - `__tests__/HpaKafkaIntegration.test.ts`

- **Scripts:**
  - `scripts/hpa-load-test.ts` - Load testing and HPA validation
  - `scripts/purge-expired-plan-states.ts` - Cleanup old plan states

- **Helm configuration:**
  - `charts/oss-ai-agent-tool/values.yaml` - Queue adapter configuration
  - `charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml` - Queue depth alerts
