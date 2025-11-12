# Code Review: Docker Compose Configurations

This document summarizes the findings of the code review for Docker Compose configurations (`compose.dev.yaml` and `docker-compose.prod.yaml`).

## Summary

The Docker Compose files provide clear separation between development and production environments. Security hardening (no-new-privileges, read-only) is well-implemented. However, critical gaps exist in secrets management, network isolation, resource limits, and production credential handling.

**Overall Status:** Good (requires immediate security improvements for production)

## Dev vs Prod Comparison

| Aspect | Dev (`compose.dev.yaml`) | Prod (`docker-compose.prod.yaml`) | Assessment |
|--------|--------------------------|----------------------------------|------------|
| **Images** | Build from source | Pre-built from registry | ✅ Correct |
| **Security Options** | Partial (some services) | Consistent (all services) | ⚠️ Dev needs improvement |
| **Read-only FS** | Partial | Consistent | ⚠️ Dev needs improvement |
| **Health Checks** | Missing | Implemented for deps | ✅ Good |
| **Depends On** | service_started | service_healthy | ✅ Good progression |
| **Port Exposure** | All ports exposed | Limited exposure | ⚠️ Prod should limit more |
| **Secrets** | Hardcoded defaults | Env var refs | ❌ Still uses defaults |
| **Network Isolation** | None | None | ❌ CRITICAL GAP |
| **Resource Limits** | None | None | ❌ CRITICAL GAP |
| **Restart Policy** | unless-stopped | unless-stopped | ✅ Appropriate |

## Findings by Category

### 1. Security Settings

#### Positive

-   **no-new-privileges**: ✅ Applied to all services in prod, most in dev
-   **read_only**: ✅ Applied to gateway, orchestrator, indexer in prod
-   **Non-root users**: ✅ Implied by using official images (postgres:alpine, redis, kafka run as non-root)

#### Critical Gaps

-   **No AppArmor/SELinux profiles**: Missing container confinement
-   **No capability drops**: Containers run with default capabilities
-   **No user specification**: Should explicitly set `user: "65532:65532"`
-   **No tmpfs mounts**: Read-only containers need writable /tmp

### 2. Secrets Management

#### Dev Environment

-   **CRITICAL**: Hardcoded credentials (postgres: ossaat/ossaat, rabbitmq: guest/guest)
-   **CRITICAL**: Dev passphrase exposed in plaintext: `dev-local-passphrase`
-   **CRITICAL**: Langfuse secret keys: `dev-secret`, `dev-salt`

#### Prod Environment

-   **CRITICAL**: Still uses default passwords as fallback:
    - `POSTGRES_PASSWORD:-ossaat`
    - `RABBITMQ_PASSWORD:-guest`
    - `NEXTAUTH_SECRET:-replace-me`
-   **CRITICAL**: No Docker secrets integration
-   **CRITICAL**: Environment variables visible in `docker inspect`

#### Recommendations

Use Docker secrets:
```yaml
secrets:
  postgres_password:
    external: true
  rabbitmq_password:
    external: true

services:
  postgres:
    secrets:
      - postgres_password
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
```

### 3. Network Isolation

#### Current State

- **CRITICAL**: No custom networks defined. All services on default bridge network.
- **CRITICAL**: All services can communicate with all others. No segmentation.

#### Recommended Architecture

```yaml
networks:
  frontend:  # gateway only
  backend:   # orchestrator, indexer
  data:      # postgres, redis, rabbitmq, kafka (no internet)
  
services:
  gateway:
    networks:
      - frontend
      - backend
  
  orchestrator:
    networks:
      - backend
      - data
  
  postgres:
    networks:
      - data  # isolated from internet
```

### 4. Volume Mounts

#### Positive

-   **Named volumes**: ✅ Used for all persistent data
-   **Data persistence**: ✅ Postgres, Redis, RabbitMQ, Kafka, Langfuse

#### Issues

-   **No volume permissions**: Should specify uid:gid for volume ownership
-   **No backup strategy**: Volumes not backed up

### 5. Port Exposure

#### Dev Environment

Exposed ports:
- Gateway: 8080
- Orchestrator: 4000
- Indexer: 7070
- Redis: 6379
- Postgres: 5432
- RabbitMQ: 5672, 15672
- Kafka: 9092
- Jaeger: 16686, 4317, 4318
- Langfuse: 3000

**Assessment**: ✅ Appropriate for dev (all accessible for debugging)

#### Prod Environment

**CRITICAL**: Still exposes internal ports:
- Redis: 6379 (should be internal only)
- Postgres: 5432 (should be internal only)
- RabbitMQ: 15672 (management UI - should be behind auth/VPN)
- Langfuse: 3000 (should be behind reverse proxy)

### 6. Resource Limits

**CRITICAL**: No resource limits defined in either environment.

Should add:
```yaml
services:
  orchestrator:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
```

Without limits:
- Single service can consume all host resources
- OOM killer may terminate wrong processes
- No cost predictability

### 7. Environment Variables

#### Security Issues

-   **Plaintext secrets**: All credentials passed as env vars
-   **No validation**: Invalid values cause runtime failures
-   **No defaults documentation**: Users don't know which vars are required

#### Missing Variables

-   API keys for providers (OpenAI, Anthropic, etc.)
-   OAuth client secrets
-   Vault connection details (if using Vault)

### 8. Health Checks

#### Prod (Good)

-   ✅ Redis: `redis-cli ping`
-   ✅ Postgres: `pg_isready`

#### Missing

-   Gateway (should check /healthz)
-   Orchestrator (should check /healthz)
-   Indexer (should check health endpoint)
-   RabbitMQ (should check management API)
-   Kafka (should check broker status)

### 9. Dependency Management

#### Prod (Good)

-   ✅ Uses `condition: service_healthy` for critical dependencies
-   ✅ Orchestrator waits for DB health before starting

#### Dev (Needs Improvement)

-   ⚠️ Uses `service_started` which doesn't guarantee readiness
-   Risk of connection failures during startup

### 10. Service Definitions

#### Issues

-   **Kafka auto-create topics**: Disabled in prod (good), enabled in dev (acceptable but should document why)
-   **Jaeger ports**: Dev exposes all ports, prod only UI. ✅ Correct approach.

## Recommendations (Prioritized)

### Critical (P0) - Security

1.  **Implement Docker Secrets**:
```bash
echo "strong-password" | docker secret create postgres_password -
docker-compose -f docker-compose.prod.yaml up
```

2.  **Add Network Segmentation**:
```yaml
networks:
  frontend:
  backend:
  data:
    internal: true  # No internet access
```

3.  **Remove Default Password Fallbacks**: Prod should fail fast if secrets not provided.

4.  **Add AppArmor/SELinux Profiles**:
```yaml
security_opt:
  - no-new-privileges:true
  - apparmor:docker-default
  - seccomp:unconfined  # Or custom profile
```

5.  **Explicit User Specification**:
```yaml
user: "65532:65532"  # nonroot user
```

6.  **Drop Capabilities**:
```yaml
cap_drop:
  - ALL
cap_add:
  - NET_BIND_SERVICE  # Only if needed
```

### High (P1) - Production Readiness

7.  **Add Resource Limits**: CPU and memory limits for all services.

8.  **Add Health Checks**: For gateway, orchestrator, indexer, rabbitmq, kafka.

9.  **Restrict Port Exposure**: Remove external access to internal services in prod.

10. **Add tmpfs for Read-Only Containers**:
```yaml
tmpfs:
  - /tmp
  - /var/run
```

11. **Implement Logging Driver**:
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

12. **Add Container Labels**:
```yaml
labels:
  - "com.example.app=oss-ai-agent-tool"
  - "com.example.environment=production"
  - "com.example.version=${TAG}"
```

### Medium (P2) - Enhancements

13. **Add .env File Template**: Document all required environment variables.

14. **Implement Backup Volumes**:
```yaml
x-backup-schedule: &backup
  image: instrumentisto/rsync-ssh
  volumes:
    - postgres-data:/data:ro
  command: rsync to backup server
```

15. **Add Watchtower for Auto-Updates** (dev only):
```yaml
watchtower:
  image: containrrr/watchtower
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
```

16. **Implement Service Dependencies with Timeouts**:
```yaml
depends_on:
  postgres:
    condition: service_healthy
    restart: true
```

### Low (P3) - Nice to Have

17. **Add Container Monitoring**: Prometheus exporter sidecars.

18. **Implement Blue-Green Deployment**: Multiple compose files for zero-downtime updates.

19. **Add Development Tools Service**: Include pgAdmin, Redis Commander, Kafka UI in dev.

20. **Document Makefile Targets**: `make dev-up`, `make prod-up`, `make logs`, etc.

## Security Hardening Checklist

### Container Security
- [ ] No-new-privileges on all services
- [ ] Read-only root filesystem where possible
- [ ] Explicit user specification (non-root)
- [ ] Capability drops (ALL)
- [ ] AppArmor/SELinux profiles
- [ ] Seccomp profiles
- [ ] tmpfs mounts for writable paths

### Network Security
- [ ] Custom networks defined
- [ ] Network segmentation (frontend/backend/data)
- [ ] Internal-only networks for databases
- [ ] No unnecessary port exposure
- [ ] TLS between services (if applicable)

### Secrets Management
- [ ] Docker secrets for all credentials
- [ ] No default password fallbacks in prod
- [ ] Secrets mounted as files (not env vars)
- [ ] Secret rotation strategy documented

### Resource Management
- [ ] CPU limits on all services
- [ ] Memory limits on all services
- [ ] PID limits
- [ ] Ulimit settings

### Observability
- [ ] Health checks on all services
- [ ] Logging drivers configured
- [ ] Log rotation enabled
- [ ] Container labels for identification

## Example Hardened Service

```yaml
services:
  orchestrator:
    image: "${REGISTRY}/orchestrator:${TAG}"
    user: "65532:65532"
    read_only: true
    security_opt:
      - no-new-privileges:true
      - apparmor:docker-default
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:noexec,nosuid,size=100M
    networks:
      - backend
      - data
    secrets:
      - postgres_password
      - rabbitmq_password
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:4000/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
```

## Makefile Integration

Recommended Makefile targets:

```makefile
.PHONY: dev-up dev-down prod-up prod-down

dev-up:
	docker-compose -f compose.dev.yaml up -d

dev-down:
	docker-compose -f compose.dev.yaml down

prod-up:
	@test -n "$(TAG)" || (echo "TAG not set"; exit 1)
	docker-compose -f docker-compose.prod.yaml up -d

prod-down:
	docker-compose -f docker-compose.prod.yaml down

logs:
	docker-compose -f docker-compose.prod.yaml logs -f

ps:
	docker-compose -f docker-compose.prod.yaml ps

backup:
	docker-compose exec postgres pg_dump -U ossaat > backup.sql
```

## Migration from Dev to Prod

Checklist before deploying prod compose:

1. Generate all secrets: `docker secret create ...`
2. Set all required env vars (no defaults)
3. Create external networks if using
4. Initialize volumes with correct permissions
5. Test health checks locally
6. Verify resource limits appropriate for host
7. Test restart behavior
8. Document rollback procedure

## Compliance with Architectural Doctrine

| Requirement | Status | Notes |
|-------------|--------|-------|
| Non-root execution | ⚠️  PARTIAL | Images use non-root but not explicit |
| Read-only filesystem | ⚠️  PARTIAL | Applied in prod, missing in dev |
| Secrets management | ❌ FAIL | Environment variables, no Docker secrets |
| Network isolation | ❌ FAIL | All services on default network |
| Resource limits | ❌ FAIL | No limits defined |
| Health checks | ⚠️  PARTIAL | Only dependencies in prod |
| Least privilege | ⚠️  PARTIAL | no-new-privileges but capabilities not dropped |
| Observability | ⚠️  PARTIAL | Jaeger + Langfuse but no health monitoring |

