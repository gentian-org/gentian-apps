{{- define "odoo-adapter.fullname" -}}
{{ default .Release.Name .Values.fullnameOverride }}
{{- end }}

{{- define "odoo-adapter.labels" -}}
app.kubernetes.io/name: odoo-adapter
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "odoo-adapter.selectorLabels" -}}
app.kubernetes.io/name: odoo-adapter
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
