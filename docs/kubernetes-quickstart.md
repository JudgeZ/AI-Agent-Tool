# Kubernetes Quickstart

Deploy the OSS AI Agent Tool to Kubernetes using the bundled Helm chart. This guide targets a development or staging cluster and assumes you have completed the [Docker Quickstart](./docker-quickstart.md) locally.

## Prerequisites

* Kubernetes 1.26+
* `kubectl`
* Helm 3.12+
* Access to a container registry (GHCR recommended)
* TLS/Ingress controller for external access (e.g., NGINX Ingress)
* Provider credentials stored in secrets (see [Model Authentication](./model-authentication.md))

## 1. Build and push container images

Use the provided GitHub Actions workflow (`release-images.yml`) on a tag, or build locally with `docker buildx`:

```bash
# Option A: run via GitHub Actions
git tag v0.3.0
git push origin v0.3.0

# Option B: local build & push
export REGISTRY=ghcr.io/<owner>/oss-ai-agent-tool
export VERSION=dev

docker login ghcr.io -u <github-username> -p <token>

# Build and push the gateway API image
docker buildx build \
  --platform linux/amd64 \
  --tag "$REGISTRY/gateway-api:$VERSION" \
  --file apps/gateway-api/Dockerfile \
  apps/gateway-api \
  --push

# Build and push the orchestrator image
docker buildx build \
  --platform linux/amd64 \
  --tag "$REGISTRY/orchestrator:$VERSION" \
  --file services/orchestrator/Dockerfile \
  services/orchestrator \
  --push

# Repeat for additional services (e.g., indexer) once their Dockerfiles are available
```

Images are published under `ghcr.io/<owner>/oss-ai-agent-tool/<service>` and signed with cosign when built by CI. See [CI/CD](./ci-cd.md) for automation details.

## 2. Add the Helm repository

Charts are released to GitHub Pages and GHCR. Pick one of the options below.

### GitHub Pages index

```bash
helm repo add oss-ai-agent-tool https://<owner>.github.io/OSS-AI-Agent-Tool
helm repo update
```

### OCI registry

```bash
helm registry login ghcr.io -u <github-username> -p <token>
helm pull oci://ghcr.io/<owner>/oss-ai-agent-tool/charts/oss-ai-agent-tool --version <x.y.z>
helm install ossaat oci://ghcr.io/<owner>/oss-ai-agent-tool/charts/oss-ai-agent-tool --version <x.y.z>
```

## 3. Configure values

Create a values file (`values.local.yaml`) tailored to your cluster:

```yaml
runMode: consumer
image:
  registry: ghcr.io/<owner>/oss-ai-agent-tool
  pullPolicy: IfNotPresent
messaging:
  type: rabbitmq            # or kafka
rabbitmq:
  enabled: true
kafka:
  enabled: false
postgres:
  storageClass: standard
secrets:
  backend: localfile
  mounts:
    providerCredentials: secret/provider-tokens
orchestrator:
  env:
    LOCAL_SECRETS_PASSPHRASE: "change-me"
    # Surface tenant-aware queue metrics for HPAs and dashboards.
    # You can include additional attributes (service.name, deployment.environment, etc.).
    # The tenant label is exported on every queue depth/lag metric.
    OTEL_RESOURCE_ATTRIBUTES: "tenant.id=demo,service.name=oss-orchestrator"
# Optional: direct the keystore somewhere other than /app/config/secrets/local/secrets.json
#   LOCAL_SECRETS_PATH: /mnt/credentials/secrets.json
observability:
  jaeger:
    enabled: true
  langfuse:
    enabled: true
monitoring:
  serviceMonitor:
    enabled: true
  grafana:
    enabled: true
    namespace: monitoring
```

When Kafka is enabled, the default HorizontalPodAutoscaler targets the `orchestrator_queue_lag`
metric with a label selector of `{ queue: plan.steps, transport: kafka }`. Override
`orchestrator.hpa.metricSelector` if you rename topics or use multiple queue groups.
The same metrics power the optional Grafana dashboard (`monitoring.grafana.enabled=true`) and
Prometheus `ServiceMonitor` (`monitoring.serviceMonitor.enabled=true`).

### Optional: enable internal mTLS with cert-manager

1. Install cert-manager (v1.13+) in your cluster if it is not already present.
2. Create or reference a ClusterIssuer/Issuer that will sign internal certificates. A quick self-signed example:

   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: ossaat-internal-ca
   spec:
     selfSigned: {}
   ```

3. Extend your `values.local.yaml` with the mTLS block:

   ```yaml
   mtls:
     enabled: true
     certManager:
       issuerRef:
         name: ossaat-internal-ca
   # Optional SAN overrides for the orchestrator certificate
   # orchestrator:
   #   additionalDnsNames:
   #     - orchestrator.dev.svc.local
   ```

When enabled, the chart issues certificates for the orchestrator and gateway automatically, mounts them into the pods, and switches `ORCHESTRATOR_URL` to `https://`. Health checks are updated to use HTTPS, and the gateway enforces certificate validation/rotation transparently. Disable `mtls.certManager.enabled` if you prefer to manage the TLS secrets yourself.

## 4. Install the chart

```bash
helm install ossaat charts/oss-ai-agent-tool -f values.local.yaml
```

Or, when using the packaged chart:

```bash
helm install ossaat oss-ai-agent-tool/oss-ai-agent-tool -f values.local.yaml
```

Monitor the rollout:

```bash
kubectl get pods -l app.kubernetes.io/instance=ossaat -w
```

## 5. Expose the services

The chart provisions Deployments and ClusterIP Services for both the gateway API and orchestrator. To reach them externally:

* Enable the included Ingress template by setting `ingress.enabled=true`, specifying `ingress.className`, and providing at least one host rule.
* Alternatively, port-forward for debugging:
  ```bash
  kubectl port-forward svc/ossaat-gateway-api 8080:80
  kubectl port-forward svc/ossaat-orchestrator 4000:4000
  ```

## 6. Post-deploy checks

1. Confirm pods are healthy: `kubectl get pods -o wide`.
2. Inspect Jaeger traces: port-forward `ossaat-jaeger-query` and browse to <http://localhost:16686>.
3. Validate RabbitMQ or Kafka connectivity with the orchestrator logs (`kubectl logs deploy/ossaat-orchestrator`).
4. Run a plan from the CLI against the gateway endpoint to confirm SSE works end-to-end.

## 7. Day-2 operations

* **Scaling:** adjust `resources` or enable the HorizontalPodAutoscaler values in the chart.
* **Secrets rotation:** rotate provider tokens in the referenced secret; the orchestrator reloads them on change.
* **Upgrades:** use `helm upgrade` with a newer chart version. CI-generated SBOMs and cosign signatures support supply-chain attestation.
* **Monitoring:** integrate cluster metrics with your observability stack; Jaeger and Langfuse provide tracing and prompt analytics out of the box.
  * Enable the ServiceMonitor + Grafana dashboard values to scrape `/metrics` and visualize queue depth/lag across tenants.

## Related documentation

* [Agents](./agents.md) – how agent profiles map to Helm-managed ConfigMaps/Volumes.
* [Security Threat Model](./SECURITY-THREAT-MODEL.md) – review mitigations before exposing the deployment.
* [CI/CD](./ci-cd.md) – automate image builds and chart releases.
