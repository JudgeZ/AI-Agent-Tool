# FAQ & Troubleshooting

## Frequently Asked Questions

### How do I switch between RabbitMQ and Kafka?
See [Consumer vs Enterprise Modes](./consumer-enterprise-modes.md). You can toggle the message bus in your Helm values or Docker Compose configuration.

### How do I add a new model provider?
Refer to the [Provider Integration Guide](./PROVIDER_INTEGRATION_GUIDE.md).

### Where are the logs?
- **Docker**: `docker compose logs -f`
- **Kubernetes**: `kubectl logs -l app=oss-ai-agent-tool`
- **Traces**: Visit the Jaeger UI (default port 16686).

## Troubleshooting

### "Gateway not accepting requests"
Ensure the Orchestrator is running and healthy. The Gateway waits for the Orchestrator to be ready. Check `docker compose logs orchestrator`.

### "Rate limit exceeded"
Check your provider quotas. You can configure rate limits in the `resilience.ts` configuration or via environment variables.

### Agent permissions denied
Check the agent's `approval_policy` in `agents/<name>/agent.md`. If `repo.write` or `network.egress` requires approval, the step will pause until approved via the GUI or CLI.

