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
    Write-Error "Docker is required but not found. Please install Docker Desktop."
}
try {
    docker info > $null 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Docker daemon is not running." }
} catch {
    Write-Error "Docker daemon is not running. Please start Docker Desktop."
}

if (-not (Check-Command "winget")) {
    Write-Warning "Winget not found. Skipping auto-installation of tools. Please ensure kind, helm, and kubectl are installed."
} else {
    if (-not (Check-Command "kind")) {
        Write-Host "Installing Kind..."
        winget install Kubernetes.kind --accept-source agreements --accept-package-agreements
    }

    if (-not (Check-Command "helm")) {
        Write-Host "Installing Helm..."
        winget install Helm.Helm --accept-source agreements --accept-package-agreements
    }

    if (-not (Check-Command "kubectl")) {
        Write-Host "Installing Kubectl..."
        winget install Kubernetes.kubectl --accept-source agreements --accept-package-agreements
    }
    
    # Refresh env vars only if we installed something (this is best effort in current shell)
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

# Verify tools again
foreach ($tool in @("kind", "helm", "kubectl")) {
    if (-not (Check-Command $tool)) {
        Write-Error "$tool is required but not found in PATH."
    }
}

# Configuration
$ClusterName = "oss-ai-agent-tool"
$Registry = "ghcr.io/yourorg/oss-ai-agent-tool"
$Version = "dev"
$Namespace = "ossaat"

# 1. Create Cluster
if (kind get clusters | Select-String -Pattern "^$ClusterName$") {
    Write-Host "Cluster $ClusterName already exists."
} else {
    Write-Host "Creating Kind cluster $ClusterName..."
    kind create cluster --name $ClusterName
}

# 2. Build Images
Write-Host "Building Docker images..."
$images = @(
    @{ Name="gateway-api"; Context="apps/gateway-api"; Dockerfile="apps/gateway-api/Dockerfile" },
    @{ Name="orchestrator"; Context="services/orchestrator"; Dockerfile="services/orchestrator/Dockerfile" },
    @{ Name="indexer"; Context="services/indexer"; Dockerfile="services/indexer/Dockerfile" }
)

foreach ($img in $images) {
    $imgTag = "$Registry/$($img.Name):$Version"
    # Join-Path combined with $RepoRoot ensures we are independent of CWD
    $buildContext = Join-Path $RepoRoot $img.Context
    $dockerfile = Join-Path $RepoRoot $img.Dockerfile
    
    Write-Host "Building $imgTag..."
    Write-Host "  Context: $buildContext"
    Write-Host "  Dockerfile: $dockerfile"
    
    docker buildx build --load -t "$imgTag" -f $dockerfile $buildContext
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to build $($img.Name)" }
}

# 3. Load Images into Kind
Write-Host "Loading images into Kind..."
foreach ($img in $images) {
    $imgTag = "$Registry/$($img.Name):$Version"
    kind load docker-image "$imgTag" --name $ClusterName
}

# 4. Prepare Helm Values
$ValuesFile = Join-Path $RepoRoot "values.local.yaml"
if (-not (Test-Path $ValuesFile)) {
    Write-Host "Creating $ValuesFile..."
    @"
image:
  repo: $Registry
  tag: "$Version"
  pullPolicy: IfNotPresent

messaging:
  type: rabbitmq

postgres:
  enabled: true
  image: bitnami/postgresql:latest
  password: "dev-password"
  containerSecurityContext:
    readOnlyRootFilesystem: false

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

# Disable ingress for local test unless configured
ingress:
  enabled: false
"@ | Out-File -FilePath $ValuesFile -Encoding UTF8
}

# 5. Deploy with Helm
Write-Host "Deploying to Kubernetes..."
$ChartPath = Join-Path $RepoRoot "charts/oss-ai-agent-tool"
helm upgrade --install ossaat $ChartPath `
    -n $Namespace `
    --create-namespace `
    -f $ValuesFile

Write-Host "Deployment complete!"
Write-Host "Check pods with: kubectl get pods -n $Namespace"
