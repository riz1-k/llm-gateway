{{/* Chart name. */}}
{{- define "switchyard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name (≤ 63 chars, DNS-1123). */}}
{{- define "switchyard.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "switchyard.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels. */}}
{{- define "switchyard.labels" -}}
helm.sh/chart: {{ include "switchyard.chart" . }}
{{ include "switchyard.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: switchyard
{{- end }}

{{- define "switchyard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "switchyard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Selector labels for one component: api | worker | migrate. */}}
{{- define "switchyard.componentSelector" -}}
{{ include "switchyard.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "switchyard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "switchyard.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* image reference: repository[:tag][@digest] */}}
{{- define "switchyard.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end }}

{{- define "switchyard.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "switchyard.fullname" . }}
{{- end }}
{{- end }}

{{- define "switchyard.configMapName" -}}
{{- if .Values.existingConfigMap }}
{{- .Values.existingConfigMap }}
{{- else }}
{{- include "switchyard.fullname" . }}
{{- end }}
{{- end }}

{{/*
Effective gateway.yaml: user config with the ports the chart wires up forced in, and the
pricing file pointed at the shipped/default table unless the config sets its own.
*/}}
{{- define "switchyard.gatewayConfig" -}}
{{- $cfg := deepCopy (.Values.config | default dict) -}}
{{- $server := mustMergeOverwrite (dict) ($cfg.server | default dict) (dict "port" .Values.api.port "host" "0.0.0.0") -}}
{{- $metrics := mustMergeOverwrite (dict "enabled" true "path" "/metrics") ($cfg.metrics | default dict) (dict "port" .Values.api.metricsPort) -}}
{{- $_ := set $cfg "server" $server -}}
{{- $_ := set $cfg "metrics" $metrics -}}
{{- if not (hasKey $cfg "pricing_file") -}}
{{- $_ := set $cfg "pricing_file" (ternary "/etc/switchyard/pricing.json" "/app/config/pricing.json" (not (empty .Values.pricing))) -}}
{{- end -}}
{{- toYaml $cfg -}}
{{- end }}

{{/* Pod-level settings shared by the api and worker Deployments. */}}
{{- define "switchyard.podCommon" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
serviceAccountName: {{ include "switchyard.serviceAccountName" . }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end }}

{{/* Environment shared by all Switchyard containers. */}}
{{- define "switchyard.env" -}}
envFrom:
  - secretRef:
      name: {{ include "switchyard.secretName" . }}
env:
  - name: SWITCHYARD_CONFIG
    value: /etc/switchyard/gateway.yaml
  {{- range $k, $v := .Values.env }}
  - name: {{ $k }}
    value: {{ $v | toString | quote }}
  {{- end }}
{{- end }}

{{- define "switchyard.configVolume" -}}
- name: config
  configMap:
    name: {{ include "switchyard.configMapName" . }}
- name: tmp
  emptyDir:
    sizeLimit: 64Mi
{{- end }}

{{- define "switchyard.configMounts" -}}
- name: config
  mountPath: /etc/switchyard
  readOnly: true
- name: tmp
  mountPath: /tmp
{{- end }}

{{/* HPA spec body for a component: (dict "ctx" $ "component" "api" "values" .Values.api) */}}
{{- define "switchyard.hpa" -}}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "switchyard.fullname" .ctx }}-{{ .component }}
  namespace: {{ .ctx.Release.Namespace }}
  labels:
    {{- include "switchyard.labels" .ctx | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "switchyard.fullname" .ctx }}-{{ .component }}
  minReplicas: {{ .values.autoscaling.minReplicas }}
  maxReplicas: {{ .values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .values.autoscaling.targetCPUUtilizationPercentage }}
    {{- with .values.autoscaling.metrics }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with .values.autoscaling.behavior }}
  behavior:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}

{{/* PDB for a component. */}}
{{- define "switchyard.pdb" -}}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "switchyard.fullname" .ctx }}-{{ .component }}
  namespace: {{ .ctx.Release.Namespace }}
  labels:
    {{- include "switchyard.labels" .ctx | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  minAvailable: {{ .values.pdb.minAvailable }}
  selector:
    matchLabels:
      {{- include "switchyard.componentSelector" (dict "ctx" .ctx "component" .component) | nindent 6 }}
{{- end }}
