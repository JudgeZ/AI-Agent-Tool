$ErrorActionPreference = "Stop"

# Resolve the repository root path relative to this script
$RepoRoot = Resolve-Path "$PSScriptRoot/.."
Write-Host "Repository root detected at: $RepoRoot"

function Check-Command {
    param ($Name)
    if (Get-Command $Name -ErrorAction SilentlyContinue) {
        return $true
    }
    return $false
}

Write-Host "Checking prerequisites..."

# Check Docker daemon
if (-not (Check-Command "docker")) {
    Write-Error "Docker is required but not found."
}
try {
    docker info > $null 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Docker daemon is not running." }
} catch {
    Write-Error "Docker daemon is not running."
}

# Check for kubectl and helm
foreach ($tool in @("helm", "kubectl")) {
    if (-not (Check-Command $tool)) {
        Write-Error "$tool is required but not found in PATH."
    }
}

# Check for Docker Desktop Kubernetes context
$Contexts = kubectl config get-contexts -o name
if ($Contexts -contains "docker-desktop") {
    Write-Host "Switching to docker-desktop context..."
    kubectl config use-context docker-desktop
} elseif ($Contexts -contains "kind-docker-desktop") {
    Write-Host "Switching to kind-docker-desktop context..."
    kubectl config use-context kind-docker-desktop
} else {
    # Fallback: try to find any context with 'docker' in the name
    $DockerContext = $Contexts | Where-Object { $_ -like "*docker*" } | Select-Object -First 1
    if ($DockerContext) {
        Write-Host "Switching to $DockerContext context..."
        kubectl config use-context $DockerContext
    } else {
        Write-Error "Could not find a 'docker-desktop' or similar Kubernetes context. Please check your cluster name."
    }
}

# Configuration
$Registry = "ghcr.io/yourorg/oss-ai-agent-tool"
$Version = "dev"
$Namespace = "ossaat"

# 1. Build Images
Write-Host "Building Docker images..."
$images = @(
    @{ Name="gateway-api"; Context="apps/gateway-api"; Dockerfile="apps/gateway-api/Dockerfile" },
    @{ Name="orchestrator"; Context="services/orchestrator"; Dockerfile="services/orchestrator/Dockerfile" },
    @{ Name="indexer"; Context="services/indexer"; Dockerfile="services/indexer/Dockerfile" }
)

foreach ($img in $images) {
    $imgTag = "$Registry/$($img.Name):$Version"
    $buildContext = Join-Path $RepoRoot $img.Context
    $dockerfile = Join-Path $RepoRoot $img.Dockerfile
    
    Write-Host "Building $imgTag..."
    # Note: Docker Desktop K8s uses the local Docker engine, so no 'load' step is needed.
    docker build -t "$imgTag" -f $dockerfile $buildContext
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to build $($img.Name)" }
}

# 2. Prepare Helm Values
$ValuesFile = Join-Path $RepoRoot "values.local.yaml"
# We regenerate this to ensure it matches the setup
Write-Host "Creating/Updating $ValuesFile..."
@"
image:
  repo: $Registry
  tag: "$Version"
  pullPolicy: IfNotPresent

messaging:
  type: rabbitmq

postgres:
  enabled: true
  image: ankane/pgvector:v0.5.1
  password: "dev-password"
  podSecurityContext:
    runAsNonRoot: false
    fsGroup: 0
    runAsUser: 0
  containerSecurityContext:
    runAsUser: 0
    readOnlyRootFilesystem: false
    allowPrivilegeEscalation: true
    capabilities:
      drop: []
  persistence:
    enabled: false

rabbitmq:
  enabled: true
  image: rabbitmq:3.13-management
  podSecurityContext:
    runAsNonRoot: true
    runAsUser: 999
    runAsGroup: 999
    fsGroup: 999
  containerSecurityContext:
    readOnlyRootFilesystem: false

redis:
  enabled: true
  image: bitnami/redis:latest
  containerSecurityContext:
    readOnlyRootFilesystem: false

jaeger:
  enabled: true

ingress:
  enabled: false
"@ | Out-File -FilePath $ValuesFile -Encoding UTF8

# 3. Deploy with Helm
Write-Host "Deploying to Kubernetes (docker-desktop)..."
$ChartPath = Join-Path $RepoRoot "charts/oss-ai-agent-tool"
helm upgrade --install ossaat $ChartPath `
    -n $Namespace `
    --create-namespace `
    -f $ValuesFile

Write-Host "Deployment complete!"
Write-Host "Check pods with: kubectl get pods -n $Namespace"

