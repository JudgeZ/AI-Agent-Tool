# Code Review: Build Configuration

This document summarizes the findings of the code review for build configuration across all components.

## Summary

Build configuration is well-structured with clear Make targets, proper dependency management, and automated updates via Renovate. However, gaps exist in security scanning during build, vulnerability checks, and reproducible builds.

**Overall Status:** Good (requires security and reproducibility improvements)

## Findings by Category

### 1. Makefile (Root)

#### Positive

-   ✅ Clear, organized targets (build, push, helm-install)
-   ✅ Parameterized with sensible defaults (REGISTRY, VERSION, PLATFORM)
-   ✅ Uses docker buildx for multi-platform builds
-   ✅ Separate targets for Kafka vs RabbitMQ deployment

#### Issues

-   **CRITICAL**: No security scanning in build pipeline
-   **CRITICAL**: No build provenance/SBOM generation
-   **NEEDS IMPROVEMENT**: No `make test` target
-   **NEEDS IMPROVEMENT**: No `make lint` target
-   **NEEDS IMPROVEMENT**: No `make clean` target
-   **NEEDS IMPROVEMENT**: Hardcoded defaults (yourorg, PLATFORM=linux/amd64 only)

### 2. Renovate Configuration

#### Positive

-   ✅ Extends recommended config + security
-   ✅ Dependency dashboard enabled
-   ✅ Scheduled updates (Monday 3-6 AM)
-   ✅ Semantic commits
-   ✅ Auto-merge for minor/patch npm updates
-   ✅ Grouped updates by manager type

#### Issues

-   **NEEDS IMPROVEMENT**: No vulnerability severity filtering
-   **NEEDS IMPROVEMENT**: No pin digest for Docker images
-   **NEEDS IMPROVEMENT**: No Go module updates configured
-   **NEEDS IMPROVEMENT**: No Rust crate updates configured
-   **NEEDS IMPROVEMENT**: No custom labels for breaking changes

### 3. NPM Package Management (Orchestrator)

#### Positive

-   ✅ Private package (prevents accidental publish)
-   ✅ Exports properly defined for CLI consumption
-   ✅ TypeScript compilation configured
-   ✅ postinstall script for Mistral cleanup
-   ✅ Modern dependencies (most <6 months old)

#### Issues

-   **CRITICAL**: No lockfile verification (should use `npm ci` in builds)
-   **NEEDS IMPROVEMENT**: No audit script
-   **NEEDS IMPROVEMENT**: package-lock.json should be committed (it is, but verify integrity)
-   **NEEDS IMPROVEMENT**: No pre-commit hooks (husky)

### 4. Go Modules (Gateway API)

- **Not reviewed in detail**: Need to check go.mod, go.sum for:
    - Replace directives (security risk)
    - Indirect dependencies (should be minimal)
    - Version pinning strategy
    - Vulnerability scanning integration

### 5. Cargo Configuration (Indexer)

- **Not reviewed in detail**: Need to check Cargo.toml, Cargo.lock for:
    - Workspace configuration
    - Dependency features (minimize attack surface)
    - Audit integration (cargo-audit)
    - Patch sections (vendor-specific fixes)

## Recommendations (Prioritized)

### Critical (P0) - Security

1.  **Add Security Scanning to Makefile**:
```makefile
scan: scan-gateway scan-orchestrator scan-indexer

scan-gateway:
	trivy image $(REGISTRY)/gateway-api:$(VERSION)
	grype $(REGISTRY)/gateway-api:$(VERSION)

scan-orchestrator:
	trivy image $(REGISTRY)/orchestrator:$(VERSION)
	npm audit --audit-level=moderate
```

2.  **Add SBOM Generation**:
```makefile
sbom:
	syft $(REGISTRY)/gateway-api:$(VERSION) -o cyclonedx-json > gateway-sbom.json
	syft $(REGISTRY)/orchestrator:$(VERSION) -o cyclonedx-json > orchestrator-sbom.json
```

3.  **Pin Docker Image Digests in Renovate**:
```json
{
  "packageRules": [{
    "matchDatasources": ["docker"],
    "pinDigests": true
  }]
}
```

4.  **Add Pre-Commit Hooks**:
```json
// package.json
{
  "devDependencies": {
    "husky": "^8.0.0",
    "lint-staged": "^15.0.0"
  },
  "scripts": {
    "prepare": "husky install"
  }
}
```

### High (P1) - Build Quality

5.  **Add Test Target**:
```makefile
test: test-gateway test-orchestrator test-indexer

test-gateway:
	cd $(GATEWAY_API_CONTEXT) && go test -v -race ./...

test-orchestrator:
	cd $(ORCHESTRATOR_CONTEXT) && npm test

test-indexer:
	cd $(INDEXER_CONTEXT) && cargo test
```

6.  **Add Lint Targets**:
```makefile
lint: lint-gateway lint-orchestrator lint-indexer

lint-gateway:
	cd $(GATEWAY_API_CONTEXT) && golangci-lint run

lint-orchestrator:
	cd $(ORCHESTRATOR_CONTEXT) && npm run lint

lint-indexer:
	cd $(INDEXER_CONTEXT) && cargo clippy -- -D warnings
```

7.  **Add Clean Target**:
```makefile
clean:
	docker rmi $(REGISTRY)/gateway-api:$(VERSION) || true
	docker rmi $(REGISTRY)/orchestrator:$(VERSION) || true
	docker rmi $(REGISTRY)/indexer:$(VERSION) || true
	docker builder prune -f
```

8.  **Enhance Renovate for Go/Rust**:
```json
{
  "packageRules": [
    {
      "matchManagers": ["gomod"],
      "groupName": "Go dependencies",
      "separateMajorMinor": true
    },
    {
      "matchManagers": ["cargo"],
      "groupName": "Rust crates",
      "separateMajorMinor": true
    }
  ]
}
```

9.  **Add Vulnerability Filtering**:
```json
{
  "vulnerabilityAlerts": {
    "enabled": true,
    "labels": ["security"],
    "assignees": ["@security-team"]
  },
  "packageRules": [{
    "matchUpdateTypes": ["patch"],
    "matchCurrentVersion": "!/^0/",
    "automerge": true,
    "minimumReleaseAge": "3 days"
  }]
}
```

10. **Add Build Reproducibility**:
```makefile
# Use SOURCE_DATE_EPOCH for reproducible builds
export SOURCE_DATE_EPOCH := $(shell date +%s)

build-gateway-api:
	docker buildx build \
		--build-arg SOURCE_DATE_EPOCH=$(SOURCE_DATE_EPOCH) \
		--build-arg VERSION=$(VERSION) \
		...
```

### Medium (P2) - Developer Experience

11. **Add Local Development Targets**:
```makefile
dev: dev-up opa-build
	@echo "Dev environment ready"

dev-up:
	docker-compose -f compose.dev.yaml up -d

dev-down:
	docker-compose -f compose.dev.yaml down -v

dev-logs:
	docker-compose -f compose.dev.yaml logs -f
```

12. **Add Multi-Platform Build**:
```makefile
build-all-platforms:
	docker buildx build \
		--platform linux/amd64,linux/arm64 \
		--push \
		-t $(REGISTRY)/gateway-api:$(VERSION) \
		...
```

13. **Add Version Tagging**:
```makefile
tag-latest:
	docker tag $(REGISTRY)/gateway-api:$(VERSION) $(REGISTRY)/gateway-api:latest
	docker push $(REGISTRY)/gateway-api:latest
```

14. **Add Dependencies Check**:
```makefile
check-deps:
	@command -v docker >/dev/null 2>&1 || { echo "docker not found"; exit 1; }
	@command -v helm >/dev/null 2>&1 || { echo "helm not found"; exit 1; }
	@command -v node >/dev/null 2>&1 || { echo "node not found"; exit 1; }
	@echo "All dependencies present"
```

### Low (P3) - Nice to Have

15. **Add Cache Management**:
```makefile
cache-prune:
	docker builder prune --all -f
	docker system prune -af --volumes
```

16. **Add Release Targets**:
```makefile
release: test lint scan build push tag-latest
	@echo "Release $(VERSION) complete"
```

17. **Add Documentation Generation**:
```makefile
docs:
	cd services/orchestrator && npm run docs
	cd docs && mkdocs build
```

## Dependency Version Matrix

| Component | Manager | Key Dependencies | Status |
|-----------|---------|------------------|--------|
| Gateway API | Go modules | Go 1.24+ | ✅ Recent |
| Orchestrator | npm | Node 20, TypeScript 5 | ✅ Recent |
| Indexer | Cargo | Rust 1.75+ | ✅ Recent |
| GUI | npm | Tauri 1.x, Svelte 4 | ✅ Recent |
| Charts | Helm | Kubernetes 1.24+ | ✅ Compatible |

## Security Dependency Checks

### Automated Scanning

```bash
# Run before each commit
npm audit --audit-level=high
go list -m all | nancy sleuth
cargo audit
trivy fs --severity HIGH,CRITICAL .
```

### Manual Review

Quarterly review of:
- Transitive dependencies (npm ls, go mod graph, cargo tree)
- License compatibility
- Deprecated packages
- Security advisories

## Build Performance Optimization

### Current Issues

- No layer caching strategy documented
- Builds repeat unchanged layers
- No parallel builds for multiple services

### Recommended Optimizations

1. **Docker Layer Caching**:
```makefile
build-gateway-api:
	docker buildx build \
		--cache-from type=registry,ref=$(REGISTRY)/gateway-api:buildcache \
		--cache-to type=registry,ref=$(REGISTRY)/gateway-api:buildcache,mode=max \
		...
```

2. **Parallel Builds**:
```makefile
build:
	$(MAKE) -j3 build-gateway-api build-orchestrator build-indexer
```

3. **Incremental Compilation**:
- Rust: Use sccache
- Go: Use build cache (`GOCACHE`)
- Node: Use npm ci with --cache

## Compliance with Architectural Doctrine

| Requirement | Status | Notes |
|-------------|--------|-------|
| Reproducible builds | ❌ FAIL | No SOURCE_DATE_EPOCH |
| Security scanning | ❌ FAIL | Not in Makefile |
| SBOM generation | ❌ FAIL | Not automated |
| Dependency updates | ✅ PASS | Renovate configured |
| Multi-platform | ⚠️  PARTIAL | buildx used but only linux/amd64 default |
| Version management | ✅ PASS | Clear VERSION variable |
| Test automation | ⚠️  PARTIAL | Tests exist but no make target |
| Lint automation | ⚠️  PARTIAL | Linters exist but no make target |

