#!/bin/bash
set -e

# scripts/setup-k8s-local.sh

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

echo "Checking prerequisites..."

if ! command_exists kind; then
    echo "Kind is missing. Please install it: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
    exit 1
fi

if ! command_exists helm; then
    echo "Helm is missing. Please install it: https://helm.sh/docs/intro/install/"
    exit 1
fi

if ! command_exists kubectl; then
    echo "Kubectl is missing. Please install it."
    exit 1
fi

CLUSTER_NAME="oss-ai-agent-tool"
REGISTRY="ghcr.io/yourorg/oss-ai-agent-tool"
VERSION="dev"
NAMESPACE="ossaat"

# 1. Create Cluster
if kind get clusters | grep -q "^$CLUSTER_NAME$"; then
    echo "Cluster $CLUSTER_NAME already exists."
else
    echo "Creating Kind cluster $CLUSTER_NAME..."
    kind create cluster --name $CLUSTER_NAME
fi

# 2. Build Images
echo "Building Docker images..."
docker buildx build --load -t "$REGISTRY/gateway-api:$VERSION" -f apps/gateway-api/Dockerfile apps/gateway-api
docker buildx build --load -t "$REGISTRY/orchestrator:$VERSION" -f services/orchestrator/Dockerfile services/orchestrator
docker buildx build --load -t "$REGISTRY/indexer:$VERSION" -f services/indexer/Dockerfile services/indexer

# 3. Load Images into Kind
echo "Loading images into Kind..."
kind load docker-image "$REGISTRY/gateway-api:$VERSION" --name $CLUSTER_NAME
kind load docker-image "$REGISTRY/orchestrator:$VERSION" --name $CLUSTER_NAME
kind load docker-image "$REGISTRY/indexer:$VERSION" --name $CLUSTER_NAME

# 4. Prepare Helm Values
VALUES_FILE="values.local.yaml"
if [ ! -f "$VALUES_FILE" ]; then
    echo "Creating $VALUES_FILE..."
    cat <<EOF > "$VALUES_FILE"
image:
  repo: $REGISTRY
  tag: "$VERSION"
  pullPolicy: IfNotPresent

messaging:
  type: rabbitmq

postgres:
  enabled: true
  password: "dev-password"

rabbitmq:
  enabled: true

redis:
  enabled: true

jaeger:
  enabled: true

ingress:
  enabled: false
EOF
fi

# 5. Deploy with Helm
echo "Deploying to Kubernetes..."
helm upgrade --install ossaat charts/oss-ai-agent-tool \
    -n $NAMESPACE \
    --create-namespace \
    -f $VALUES_FILE

echo "Deployment complete!"
echo "Check pods with: kubectl get pods -n $NAMESPACE"
