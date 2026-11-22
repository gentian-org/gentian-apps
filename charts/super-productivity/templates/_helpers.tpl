{{- define "super-productivity.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "super-productivity.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "super-productivity.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "super-productivity.labels" -}}
app.kubernetes.io/name: {{ include "super-productivity.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "super-productivity.selectorLabels" -}}
app.kubernetes.io/name: {{ include "super-productivity.name" . }}
{{- end }}

