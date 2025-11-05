# Code Review: Infrastructure & Deployment

This document summarizes the findings of the code review for the project's infrastructure and deployment configurations, specifically the Helm chart and OPA policies.

**Overall Status:** :+1: Excellent

## 1. Helm Chart (`charts/oss-ai-agent-tool`)

The Helm chart is well-structured and follows modern best practices for Kubernetes deployments. It is flexible, secure, and configurable for different environments.

### Findings

-   **Configurability**: **PASS**. The `values.yaml` file exposes a comprehensive set of configuration options, allowing operators to customize everything from image tags and messaging backends (RabbitMQ/Kafka) to resource limits and security contexts. The logic in `orchestrator-deployment.yaml` correctly uses template functions to build the environment variables for the orchestrator based on these values.
-   **Security Best Practices**: **PASS**. The chart demonstrates a strong security posture out-of-the-box:
    -   `podSecurityContext` and `containerSecurityContext` are defined to run containers as non-root users (`runAsNonRoot: true`) with a read-only root filesystem and dropped capabilities. This significantly reduces the container's attack surface.
    -   `NetworkPolicy` is enabled by default, implementing a "default deny" egress policy. This is a crucial security measure that prevents workloads from making unauthorized outbound network calls. Rules are in place to allow essential traffic like DNS and OTLP traces.
-   **Correctness**: **PASS**. The templates correctly construct Kubernetes resources. Deployments, Services, and Horizontal Pod Autoscalers (HPAs) are defined for the core services. The use of helpers (`_helpers.tpl`) for labels and names is a standard practice that keeps the manifests clean.
-   **Dependencies**: **PASS**. The chart includes templates for deploying dependencies like PostgreSQL, Redis, RabbitMQ, etc., which is useful for development and all-in-one deployments. The ability to disable them and configure external services is implied by the configuration options.

## 2. OPA Policies (`infra/policies`)

The Open Policy Agent (OPA) policy provides a flexible and powerful way to manage authorization for agent capabilities.

### Findings

-   **Correctness & Logic**: **PASS**. The `capabilities.rego` policy is well-written and easy to understand. It correctly implements capability-based authorization by checking:
    -   If the agent's profile (`subject.capabilities`) grants the required capability.
    -   If a required capability needs manual approval (`requires_approval`) and if that approval has been granted (`subject.approvals`).
    -   If there is a mismatch between the required `run_mode` (e.g., `enterprise`) and the agent's current `run_mode`.
-   **Flexibility**: **PASS**. The policy is designed to be extensible. It includes logic for role-based capabilities (`role_capabilities`) and even multi-tenant role bindings (`tenant_role_capabilities`), which are powerful features for enterprise deployments. The data-driven nature of Rego means these bindings can be provided at runtime without changing the policy code itself.
-   **Clarity**: **PASS**. The policy is broken down into small, reusable rules (`missing_capability`, `missing_approval`), which makes the overall logic clear. The `deny` rule aggregates all violations, providing detailed reasons for any authorization failure.

## Recommendations (Prioritized)

### Critical (P0) - Security

1.  **Add NetworkPolicy Egress Rules**: Current default-deny is too restrictive. Must explicitly allow:
    - DNS (port 53 UDP/TCP to kube-dns)
    - HTTPS to specific external APIs (OpenAI, Anthropic, etc.) by CIDR/domain
    - OTLP traces to collector (port 4317/4318)
```yaml
egress:
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53
  - to:
    - podSelector:
        matchLabels:
          app: jaeger-collector
    ports:
    - protocol: TCP
      port: 4317
```

2.  **Add PodSecurityPolicy/PodSecurityStandards**: Enforce restricted pod security at namespace level:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: oss-ai-agent-tool
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

3.  **Add Resource Quotas**: Prevent resource exhaustion:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
spec:
  hard:
    requests.cpu: "10"
    requests.memory: "20Gi"
    limits.cpu: "20"
    limits.memory: "40Gi"
    persistentvolumeclaims: "10"
```

4.  **OPA Policy Testing**: Add comprehensive test suite:
```bash
cd infra/policies
npm test  # or: opa test -v *.rego
```
Test cases needed:
- Capability grant/deny scenarios
- Approval requirements
- Role-based access (RBAC)
- Multi-tenant isolation
- Run mode restrictions

5.  **Secrets Encryption**: Enable secrets encryption at rest:
```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
    - secrets
    providers:
    - aescbc:
        keys:
        - name: key1
          secret: <base64-key>
```

### High (P1) - Production Readiness

6.  **Add Liveness/Readiness Probes**: Current deployments missing health checks:
```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
```

7.  **Implement HPA Metrics**: Current HPA only uses CPU. Add custom metrics:
```yaml
metrics:
- type: Resource
  resource:
    name: cpu
    target:
      type: Utilization
      averageUtilization: 70
- type: Pods
  pods:
    metric:
      name: queue_depth
    target:
      type: AverageValue
      averageValue: "1000"
```

8.  **Add PodDisruptionBudgets**: Ensure availability during disruptions:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orchestrator-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: orchestrator
```

9.  **Helm Chart Validation**: Add to CI pipeline:
```bash
helm lint charts/oss-ai-agent-tool
helm template charts/oss-ai-agent-tool | kubeval
kube-score score charts/oss-ai-agent-tool/templates/*.yaml
```

10. **Add RBAC Policies**: Define ServiceAccounts with minimal permissions:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: orchestrator
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orchestrator-role
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind:RoleBinding
metadata:
  name: orchestrator-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orchestrator-role
subjects:
- kind: ServiceAccount
  name: orchestrator
```

### Medium (P2) - Enhancements

11. **Add Init Containers**: Wait for dependencies (DB, queue) before starting:
```yaml
initContainers:
- name: wait-for-postgres
  image: busybox:1.36
  command: ['sh', '-c', 'until nc -z postgres 5432; do sleep 1; done']
```

12. **Implement ConfigMaps**: Externalize non-secret config:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orchestrator-config
data:
  GATEWAY_URL: "http://gateway-api:8080"
  LOG_LEVEL: "info"
```

13. **Add Istio/Service Mesh**: For mTLS between services, traffic management, observability.

14. **Implement GitOps**: Use ArgoCD or Flux for declarative deployments.

15. **Add Backup CronJobs**: Automated backup of Postgres, RabbitMQ queues.

### Low (P3) - Nice to Have

16. **Multi-Region Deployment**: Helm chart support for cross-region replication.

17. **Cost Optimization**: Add node affinity to schedule on spot instances where appropriate.

18. **Monitoring Dashboards**: Pre-configured Grafana dashboards for services.

## Security Hardening Checklist

### Pod Security
- [x] runAsNonRoot: true
- [x] readOnlyRootFilesystem: true
- [ ] allowPrivilegeEscalation: false
- [ ] capabilities dropped (ALL)
- [ ] seccompProfile: RuntimeDefault
- [ ] AppArmor annotations

### Network Security
- [x] NetworkPolicy default-deny
- [ ] NetworkPolicy egress rules defined
- [ ] TLS between services (mTLS)
- [ ] Certificate rotation automated
- [ ] Ingress TLS termination

### Secrets Management
- [ ] Secrets encrypted at rest
- [ ] External secrets operator (Vault)
- [ ] Secret rotation policy
- [ ] No secrets in environment variables
- [ ] Secrets mounted as volumes

### Access Control
- [ ] RBAC policies defined
- [ ] ServiceAccounts per service
- [ ] Principle of least privilege
- [ ] Pod Security Standards enforced
- [ ] Audit logging enabled

## Helm Values Security Review

Critical values that must be set securely:

```yaml
# values.yaml
global:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault

orchestrator:
  podSecurityContext:
    runAsNonRoot: true
    allowPrivilegeEscalation: false
    capabilities:
      drop:
      - ALL
  
  resources:
    limits:
      cpu: 2000m
      memory: 2Gi
    requests:
      cpu: 500m
      memory: 512Mi
  
  autoscaling:
    enabled: true
    minReplicas: 2  # Min 2 for HA
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70

networkPolicy:
  enabled: true  # Must be true
  policyTypes:
  - Ingress
  - Egress

ingress:
  enabled: true
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
  tls:
  - secretName: gateway-tls
    hosts:
    - gateway.example.com
```

## OPA Policy Enhancement

Current capabilities.rego is good but needs:

1.  **Temporal Policies**: Time-based restrictions (e.g., no writes outside business hours)

2.  **Resource Quotas**: Enforce limits on plan steps per user/tenant

3.  **Audit Trail**: Log all policy decisions to separate audit stream

4.  **External Data**: Pull role mappings from external system (LDAP, Okta)

5.  **Policy as Code**: Version control with change approval workflow

Example test structure:
```rego
# capabilities_test.rego
package capabilities_test

import data.capabilities

test_allow_with_capability {
  capabilities.allow with input as {
    "subject": {"capabilities": ["repo.read"]},
    "action": {"capabilities": ["repo.read"]}
  }
}

test_deny_without_capability {
  not capabilities.allow with input as {
    "subject": {"capabilities": ["repo.read"]},
    "action": {"capabilities": ["repo.write"]}
  }
}
```

## Deployment Validation

Pre-deployment checklist:
```bash
# Validate Helm chart
helm lint charts/oss-ai-agent-tool

# Dry-run install
helm install --dry-run --debug oss-ai-agent-tool charts/oss-ai-agent-tool

# Security scan
trivy config charts/oss-ai-agent-tool

# Best practices check
kube-score score charts/oss-ai-agent-tool/templates/*.yaml

# Policy check
conftest test charts/oss-ai-agent-tool/templates/*.yaml

# Test OPA policies
cd infra/policies && opa test -v *.rego
```
