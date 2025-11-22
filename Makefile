REGISTRY ?= ghcr.io/yourorg/oss-ai-agent-tool
VERSION ?= dev
PLATFORM ?= linux/amd64
RELEASE ?= ossaat
NAMESPACE ?= default
VALUES ?= values.local.yaml
CHART ?= charts/oss-ai-agent-tool

GATEWAY_API_CONTEXT := apps/gateway-api
GATEWAY_API_DOCKERFILE := $(GATEWAY_API_CONTEXT)/Dockerfile
ORCHESTRATOR_CONTEXT := services/orchestrator
ORCHESTRATOR_DOCKERFILE := $(ORCHESTRATOR_CONTEXT)/Dockerfile
INDEXER_CONTEXT := services/indexer
INDEXER_DOCKERFILE := $(INDEXER_CONTEXT)/Dockerfile

.PHONY: build push helm-install helm-kafka helm-rabbit opa-build opa-test lint lint-cli lint-gateway lint-gui lint-indexer lint-orchestrator

lint: lint-cli lint-gateway lint-gui lint-indexer lint-orchestrator

lint-cli:
	@echo "[lint] cli"
	cd apps/cli && npm run lint

lint-gateway:
	@echo "[lint] gateway-api"
	cd apps/gateway-api && gofmt -l . && go vet ./...

lint-gui:
	@echo "[lint] gui"
	cd apps/gui && npm run lint

lint-indexer:
	@echo "[lint] indexer"
	cd services/indexer && cargo fmt --all -- --check && cargo clippy

lint-orchestrator:
	@echo "[lint] orchestrator"
	cd services/orchestrator && npm run lint

# Gateway test helper for the collaboration proxy regression
test-gateway-collab-proxy:
	@echo "[test] gateway collaboration proxy"
	cd apps/gateway-api && GOTOOLCHAIN=local go test ./internal/gateway -run TestCollaborationProxyPreservesQuery -count=1 -short

build: build-gateway-api build-orchestrator build-indexer

build-gateway-api:
	@echo "[build] gateway-api"
	docker buildx build \
		--platform $(PLATFORM) \
		--load \
		-t $(REGISTRY)/gateway-api:$(VERSION) \
		-f $(GATEWAY_API_DOCKERFILE) $(GATEWAY_API_CONTEXT)

build-orchestrator:
	@echo "[build] orchestrator"
	docker buildx build \
		--platform $(PLATFORM) \
		--load \
		-t $(REGISTRY)/orchestrator:$(VERSION) \
		-f $(ORCHESTRATOR_DOCKERFILE) $(ORCHESTRATOR_CONTEXT)

build-indexer:
	@echo "[build] indexer"
	docker buildx build \
		--platform $(PLATFORM) \
		--load \
		-t $(REGISTRY)/indexer:$(VERSION) \
		-f $(INDEXER_DOCKERFILE) $(INDEXER_CONTEXT)

push: push-gateway-api push-orchestrator push-indexer

push-gateway-api:
	@echo "[push] gateway-api"
	docker buildx build \
		--platform $(PLATFORM) \
		--push \
		-t $(REGISTRY)/gateway-api:$(VERSION) \
		-f $(GATEWAY_API_DOCKERFILE) $(GATEWAY_API_CONTEXT)

push-orchestrator:
	@echo "[push] orchestrator"
	docker buildx build \
		--platform $(PLATFORM) \
		--push \
		-t $(REGISTRY)/orchestrator:$(VERSION) \
		-f $(ORCHESTRATOR_DOCKERFILE) $(ORCHESTRATOR_CONTEXT)

push-indexer:
	@echo "[push] indexer"
	docker buildx build \
		--platform $(PLATFORM) \
		--push \
		-t $(REGISTRY)/indexer:$(VERSION) \
		-f $(INDEXER_DOCKERFILE) $(INDEXER_CONTEXT)

helm-install:
	helm upgrade --install $(RELEASE) $(CHART) -n $(NAMESPACE) -f $(VALUES)

helm-kafka:
	helm upgrade --install $(RELEASE) $(CHART) \
		-n $(NAMESPACE) \
		--set messaging.type=kafka \
		--set kafka.enabled=true \
		--set rabbitmq.enabled=false

helm-rabbit:
	helm upgrade --install $(RELEASE) $(CHART) \
		-n $(NAMESPACE) \
		--set messaging.type=rabbitmq \
		--set kafka.enabled=false \
		--set rabbitmq.enabled=true

opa-build:
	@echo "[opa] compiling capability policy"
	node infra/policies/build.js

opa-test:
	@echo "[opa] running policy tests"
	node infra/policies/test.js
