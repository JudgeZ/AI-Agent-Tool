# Operational Runbooks

This directory contains step-by-step procedures for common operational scenarios and incident response.

## Available Runbooks

### Incident Response
- [High Queue Depth / Lag](./high-queue-depth.md) - Diagnose and resolve message queue backlogs
- [Authentication Failures](./auth-failures.md) - Resolve SSO/OIDC login problems
- [Secret Rotation Failures](./secret-rotation-failures.md) - Handle CMEK rotation and Vault token issues
- [Indexer Operations](./indexer-operations.md) - Vector search performance, symbol extraction, embedding issues

### Maintenance Operations
- [Data Retention Management](./data-retention-management.md) - Manage purge jobs and retention policies
- [Indexer Operations](./indexer-operations.md) - PostgreSQL maintenance, VACUUM, index optimization

### Monitoring & Alerting
- [Alert Response Guide](./alert-response-guide.md) - How to respond to common Prometheus alerts
- [Dashboard Interpretation](./dashboard-interpretation.md) - Understanding Grafana metrics

## Emergency Contacts

- **On-call rotation:** Check PagerDuty/OpsGenie
- **Security incidents:** security@example.com
- **Compliance issues:** compliance@example.com

## Escalation Path

1. **L1 (On-call engineer):** Initial triage and common issues
2. **L2 (Platform team):** Complex infrastructure problems
3. **L3 (Engineering leads):** Architecture decisions and critical incidents
4. **Management:** Business impact and external communication

## General Troubleshooting Steps

1. **Check monitoring dashboards** - Grafana for metrics, Jaeger for traces
2. **Review recent changes** - Helm releases, config updates, deployments
3. **Examine logs** - kubectl logs for pod output, audit logs for security events
4. **Verify external dependencies** - Vault, Kafka/RabbitMQ, PostgreSQL, LLM providers
5. **Check resource utilization** - CPU, memory, disk, network
6. **Review active alerts** - Prometheus Alertmanager for active incidents
