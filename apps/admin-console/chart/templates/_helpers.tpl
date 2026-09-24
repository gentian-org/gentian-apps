{{- define "admin-console.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The name every object of this release is derived from. A ComponentProfile
routes to Services by name, so the name has to be stable and known before the
release exists: fullnameOverride is how a profile pins it, and the operator
installs the release under the Component's name, which is the profile's.
Without an override it is <release>-<chart>, the Helm convention.
*/}}
{{- define "admin-console.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "admin-console.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "admin-console.labels" -}}
app.kubernetes.io/name: {{ include "admin-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "admin-console.podSecurityContext" -}}
runAsNonRoot: {{ .Values.podSecurity.runAsNonRoot }}
runAsUser: {{ .Values.podSecurity.runAsUser }}
fsGroup: {{ .Values.podSecurity.fsGroup }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "admin-console.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end }}
