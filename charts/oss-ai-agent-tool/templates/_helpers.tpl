{{- define "oss-ai-agent-tool.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "oss-ai-agent-tool.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "oss-ai-agent-tool.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "oss-ai-agent-tool.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oss-ai-agent-tool.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "oss-ai-agent-tool.image" -}}
{{- $repo := .Values.image.repo -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- $component := .component -}}
{{- printf "%s/%s:%s" $repo $component $tag -}}
{{- end -}}

{{- define "oss-ai-agent-tool.gatewayServiceAccountName" -}}
{{- if .Values.gatewayApi.serviceAccount.create -}}
{{- default (printf "%s-gateway" (include "oss-ai-agent-tool.fullname" .)) .Values.gatewayApi.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.gatewayApi.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.orchestratorServiceAccountName" -}}
{{- if .Values.orchestrator.serviceAccount.create -}}
{{- default (printf "%s-orchestrator" (include "oss-ai-agent-tool.fullname" .)) .Values.orchestrator.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.orchestrator.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.indexerServiceAccountName" -}}
{{- if .Values.indexer.serviceAccount.create -}}
{{- default (printf "%s-indexer" (include "oss-ai-agent-tool.fullname" .)) .Values.indexer.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.indexer.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.env" -}}
{{- range $key, $value := . }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.gatewayClientTlsSecretName" -}}
{{- $secret := default "" .Values.gatewayApi.tls.secretName -}}
{{- if and (not $secret) (and .Values.mtls (.Values.mtls.enabled)) -}}
{{- printf "%s-gateway-orchestrator-mtls" (include "oss-ai-agent-tool.fullname" .) -}}
{{- else -}}
{{- $secret -}}
{{- end -}}
{{- end -}}

{{- define "oss-ai-agent-tool.orchestratorTlsSecretName" -}}
{{- $secret := default "" .Values.orchestrator.tls.secretName -}}
{{- if and (not $secret) (and .Values.mtls (.Values.mtls.enabled)) -}}
{{- printf "%s-orchestrator-mtls" (include "oss-ai-agent-tool.fullname" .) -}}
{{- else -}}
{{- $secret -}}
{{- end -}}
{{- end -}}