{{- define "nextcloud-mcp.fullname" -}}
{{ .Release.Name }}
{{- end }}

{{- define "nextcloud-mcp.labels" -}}
app.kubernetes.io/name: nextcloud-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "nextcloud-mcp.selectorLabels" -}}
app.kubernetes.io/name: nextcloud-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
