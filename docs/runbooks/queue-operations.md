# Queue System Operational Runbook

## Overview
This runbook provides operational guidance for managing the OSS AI Agent Tool queue systems (RabbitMQ and Kafka) in production environments.

## Table of Contents
1. [System Architecture](#system-architecture)
2. [RabbitMQ Operations](#rabbitmq-operations)
3. [Kafka Operations](#kafka-operations)
4. [Monitoring and Alerting](#monitoring-and-alerting)
5. [Troubleshooting](#troubleshooting)
6. [Performance Tuning](#performance-tuning)
7. [Disaster Recovery](#disaster-recovery)

## System Architecture

### Queue Components
- **RabbitMQ**: Primary queue system for task orchestration
- **Kafka**: Alternative queue system for high-throughput scenarios
- **PlanStateStore**: PostgreSQL-backed persistence layer
- **PlanQueueRuntime**: Core orchestration engine

### Key Features
- Message persistence and durability
- Dead letter queue handling
- Automatic retry with exponential backoff
- Message idempotency via deduplication keys
- Connection pooling and auto-reconnection
- HPA integration for auto-scaling

## RabbitMQ Operations

### Configuration

#### Environment Variables
```bash
# Connection settings
RABBITMQ_URL=amqp://user:pass@rabbitmq:5672/
RABBITMQ_CONNECTION_POOL_SIZE=10
RABBITMQ_CHANNEL_POOL_SIZE=20

# Queue settings
RABBITMQ_QUEUE_NAME=plans
RABBITMQ_EXCHANGE_NAME=plans-exchange
RABBITMQ_DEAD_LETTER_QUEUE=plans-dlq
RABBITMQ_MAX_RETRIES=3
RABBITMQ_MESSAGE_TTL=86400000  # 24 hours in ms

# Performance settings
RABBITMQ_PREFETCH_COUNT=10
RABBITMQ_CONSUMER_TAG=orchestrator-consumer
```

### Common Operations

#### Check Queue Status
```bash
# Via management API
curl -u admin:password http://rabbitmq:15672/api/queues/vhost/plans

# Via CLI
rabbitmqctl list_queues name messages consumers memory

# Check dead letter queue
rabbitmqctl list_queues name messages | grep dlq
```

#### Purge Queue (Emergency Only)
```bash
# Purge specific queue
rabbitmqctl purge_queue plans

# Purge dead letter queue
rabbitmqctl purge_queue plans-dlq
```

#### Connection Management
```bash
# List connections
rabbitmqctl list_connections user peer_host peer_port state

# Close stale connections
rabbitmqctl close_connection "<connection_id>" "Maintenance"
```

### Health Checks

#### Basic Health Check
```bash
rabbitmq-diagnostics check_running
rabbitmq-diagnostics check_local_alarms
```

#### Cluster Health
```bash
rabbitmq-diagnostics cluster_status
rabbitmq-diagnostics check_if_node_is_mirror_sync_critical
```

## Kafka Operations

### Configuration

#### Environment Variables
```bash
# Connection settings
KAFKA_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092
KAFKA_CLIENT_ID=orchestrator
KAFKA_GROUP_ID=orchestrator-group

# Topic settings
KAFKA_TOPIC=plans
KAFKA_PARTITIONS=10
KAFKA_REPLICATION_FACTOR=3
KAFKA_COMPRESSION_TYPE=snappy

# Security settings
KAFKA_SASL_MECHANISM=SCRAM-SHA-512
KAFKA_SASL_USERNAME=orchestrator
KAFKA_SASL_PASSWORD=secret
KAFKA_TLS_ENABLED=true

# Performance settings
KAFKA_BATCH_SIZE=16384
KAFKA_LINGER_MS=10
KAFKA_BUFFER_MEMORY=33554432
```

### Common Operations

#### Topic Management
```bash
# List topics
kafka-topics.sh --list --bootstrap-server kafka:9092

# Describe topic
kafka-topics.sh --describe --topic plans --bootstrap-server kafka:9092

# Create topic (if auto-create disabled)
kafka-topics.sh --create \
  --topic plans \
  --partitions 10 \
  --replication-factor 3 \
  --config cleanup.policy=compact \
  --bootstrap-server kafka:9092
```

#### Consumer Group Management
```bash
# List consumer groups
kafka-consumer-groups.sh --list --bootstrap-server kafka:9092

# Check consumer lag
kafka-consumer-groups.sh --describe \
  --group orchestrator-group \
  --bootstrap-server kafka:9092

# Reset consumer offset (maintenance)
kafka-consumer-groups.sh --reset-offsets \
  --group orchestrator-group \
  --topic plans \
  --to-latest \
  --execute \
  --bootstrap-server kafka:9092
```

### Monitoring Lag
```bash
# Get detailed lag information
kafka-consumer-groups.sh --describe \
  --group orchestrator-group \
  --bootstrap-server kafka:9092 \
  | awk '{print $1,$2,$3,$4,$5,$6}' \
  | column -t
```

## Monitoring and Alerting

### Key Metrics

#### Queue Depth
- **Metric**: `queue_depth`
- **Alert Threshold**: > 1000 messages for 5 minutes
- **Action**: Scale up consumers or investigate processing bottleneck

#### Consumer Lag (Kafka)
- **Metric**: `kafka_consumer_lag`
- **Alert Threshold**: > 10000 messages for 10 minutes
- **Action**: Check consumer health, scale up if needed

#### Message Processing Rate
- **Metric**: `messages_processed_per_second`
- **Alert Threshold**: < 10 msg/s for 5 minutes
- **Action**: Check for errors, database issues, or resource constraints

#### Dead Letter Queue
- **Metric**: `dlq_message_count`
- **Alert Threshold**: > 100 messages
- **Action**: Investigate failed messages, check for poison messages

### Grafana Dashboards

Access dashboards at: `http://grafana:3000/`

1. **Queue Overview Dashboard**: Overall queue health
2. **Queue Depth Dashboard**: Detailed depth metrics
3. **HPA Dashboard**: Auto-scaling metrics
4. **Cost Dashboard**: Resource utilization

### Prometheus Queries

```promql
# Queue depth
sum(queue_depth{queue="plans"}) by (instance)

# Processing rate
rate(messages_processed_total[5m])

# Error rate
rate(message_processing_errors_total[5m])

# Consumer lag (Kafka)
kafka_consumer_lag_sum{group="orchestrator-group"}
```

## Troubleshooting

### High Queue Depth

#### Diagnosis
1. Check consumer health:
```bash
kubectl get pods -l app=orchestrator
kubectl logs -l app=orchestrator --tail=100
```

2. Check processing errors:
```bash
kubectl logs -l app=orchestrator | grep ERROR
```

3. Check database performance:
```sql
SELECT * FROM pg_stat_activity WHERE state != 'idle';
```

#### Resolution
1. Scale up consumers:
```bash
kubectl scale deployment orchestrator --replicas=10
```

2. Check for poison messages:
```bash
# RabbitMQ
rabbitmqctl list_queues name messages_unacknowledged

# Kafka
kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 \
  --topic plans \
  --from-beginning \
  --max-messages 10
```

### Connection Issues

#### RabbitMQ Connection Failures
```bash
# Check RabbitMQ logs
kubectl logs rabbitmq-0 | tail -100

# Test connectivity
nc -zv rabbitmq 5672

# Check credentials
rabbitmqctl authenticate_user orchestrator password
```

#### Kafka Connection Failures
```bash
# Test connectivity
kafka-broker-api-versions.sh --bootstrap-server kafka:9092

# Check authentication
kafka-console-consumer.sh \
  --bootstrap-server kafka:9092 \
  --topic __consumer_offsets \
  --formatter "kafka.coordinator.group.GroupMetadataManager\$OffsetsMessageFormatter" \
  --max-messages 1
```

### Message Processing Failures

#### Check Dead Letter Queue
```bash
# RabbitMQ DLQ
rabbitmqctl list_queues | grep dlq

# Move messages back to main queue
rabbitmqadmin get queue=plans-dlq count=1
rabbitmqadmin publish exchange=plans-exchange routing_key=plans
```

#### Investigate Failed Messages
```sql
-- Check plan state store for errors
SELECT id, status, error_message, retry_count 
FROM plan_states 
WHERE status = 'FAILED' 
ORDER BY updated_at DESC 
LIMIT 10;
```

## Performance Tuning

### RabbitMQ Optimization

#### Memory Management
```bash
# Set high watermark
rabbitmqctl set_vm_memory_high_watermark 0.6

# Set disk free limit
rabbitmqctl set_disk_free_limit 5GB
```

#### Connection Pooling
```yaml
# In values.yaml
rabbitmq:
  connectionPool:
    maxSize: 20
    minSize: 5
    maxIdleTime: 300
```

### Kafka Optimization

#### Producer Settings
```yaml
kafka:
  producer:
    batchSize: 32768
    lingerMs: 20
    compressionType: lz4
    bufferMemory: 67108864
```

#### Consumer Settings
```yaml
kafka:
  consumer:
    fetchMinBytes: 1024
    fetchMaxWait: 500
    maxPollRecords: 500
    sessionTimeout: 30000
```

### PostgreSQL Optimization

#### Connection Pool
```yaml
database:
  pool:
    max: 20
    min: 5
    idleTimeout: 10000
```

#### Indexes
```sql
-- Ensure indexes exist
CREATE INDEX idx_plan_states_status ON plan_states(status);
CREATE INDEX idx_plan_states_tenant ON plan_states(tenant_id);
CREATE INDEX idx_plan_states_created ON plan_states(created_at);
```

## Disaster Recovery

### Backup Procedures

#### RabbitMQ Backup
```bash
# Export definitions
rabbitmqctl export_definitions /backup/definitions.json

# Backup mnesia database
tar -czf /backup/mnesia-$(date +%Y%m%d).tar.gz /var/lib/rabbitmq/mnesia/
```

#### Kafka Backup
```bash
# Use MirrorMaker for replication
kafka-mirror-maker.sh \
  --consumer.config /etc/kafka/consumer.properties \
  --producer.config /etc/kafka/producer.properties \
  --whitelist="plans.*"
```

#### PostgreSQL Backup
```bash
# Backup plan states
pg_dump -h postgres -U orchestrator -d orchestrator \
  -t plan_states \
  -f /backup/plan_states_$(date +%Y%m%d).sql
```

### Recovery Procedures

#### RabbitMQ Recovery
```bash
# Stop RabbitMQ
rabbitmqctl stop_app

# Restore definitions
rabbitmqctl import_definitions /backup/definitions.json

# Restore mnesia (if needed)
tar -xzf /backup/mnesia-20240115.tar.gz -C /

# Start RabbitMQ
rabbitmqctl start_app
```

#### Kafka Recovery
```bash
# Restore from backup cluster
kafka-mirror-maker.sh \
  --consumer.config /etc/kafka/backup-consumer.properties \
  --producer.config /etc/kafka/producer.properties \
  --whitelist="plans.*"
```

#### PostgreSQL Recovery
```bash
# Restore plan states
psql -h postgres -U orchestrator -d orchestrator \
  -f /backup/plan_states_20240115.sql
```

### Failover Procedures

#### RabbitMQ Cluster Failover
1. Identify failed node
2. Remove from cluster:
```bash
rabbitmqctl forget_cluster_node rabbit@failed-node
```
3. Add replacement node:
```bash
rabbitmqctl join_cluster rabbit@node1
```

#### Kafka Broker Failover
1. Kafka handles automatic failover via replication
2. Monitor under-replicated partitions:
```bash
kafka-topics.sh --describe --under-replicated-partitions \
  --bootstrap-server kafka:9092
```

## Maintenance Windows

### Pre-Maintenance Checklist
1. ✅ Notify stakeholders
2. ✅ Backup current state
3. ✅ Drain queue if possible
4. ✅ Scale down consumers
5. ✅ Enable maintenance mode

### Maintenance Commands
```bash
# Enable maintenance mode
kubectl annotate deployment orchestrator maintenance="true"

# Drain RabbitMQ node
rabbitmqctl eval 'rabbit_maintenance:drain().'

# Perform maintenance tasks
# ...

# Resume normal operations
rabbitmqctl eval 'rabbit_maintenance:revive().'
kubectl annotate deployment orchestrator maintenance-
```

### Post-Maintenance Verification
1. ✅ Check queue connectivity
2. ✅ Verify message flow
3. ✅ Check consumer health
4. ✅ Monitor error rates
5. ✅ Validate metrics

## Emergency Contacts

- **On-Call Engineer**: Check PagerDuty
- **Platform Team**: #platform-team Slack channel
- **Escalation**: engineering-leads@company.com

## Related Documentation

- [Architecture Overview](../architecture/README.md)
- [Alert Response Guide](./alert-response-guide.md)
- [Monitoring Guide](../monitoring/README.md)
- [Disaster Recovery Plan](../dr/README.md)