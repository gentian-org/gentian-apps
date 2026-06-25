{{- define "gentian-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gentian-app.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "gentian-app.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gentian-app.labels" -}}
app.kubernetes.io/name: {{ include "gentian-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "gentian-app.helm.annotations" -}}
meta.helm.sh/release-name: {{ .Release.Name }}
meta.helm.sh/release-namespace: {{ .Release.Namespace }}
{{- end }}

{{- define "gentian-app.api.labels" -}}
app.kubernetes.io/name: {{ include "gentian-app.name" . }}-api
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: api
{{- end }}

{{- define "gentian-app.web.labels" -}}
app.kubernetes.io/name: {{ include "gentian-app.name" . }}-web
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}
