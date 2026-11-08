{{- define "paperless-ngx-mcp.fullname" -}}
{{ .Release.Name }}
{{- end }}

{{- define "paperless-ngx-mcp.labels" -}}
app.kubernetes.io/name: paperless-ngx-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "paperless-ngx-mcp.selectorLabels" -}}
app.kubernetes.io/name: paperless-ngx-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
