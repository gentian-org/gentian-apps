{{- define "paperless-ngx.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "paperless-ngx.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "paperless-ngx.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "paperless-ngx.labels" -}}
app.kubernetes.io/name: {{ include "paperless-ngx.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "paperless-ngx.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paperless-ngx.name" . }}
{{- end }}

{{/*
The hosts Django answers: the public one, this chart's Service (by which the
MCP companion and the bootstrap Job call in), localhost for the kubelet's
probes, and whatever the values add.
*/}}
{{- define "paperless-ngx.allowedHosts" -}}
{{- $hosts := list (include "paperless-ngx.fullname" .) "localhost" }}
{{- if .Values.appUrl }}
{{- $hosts = prepend $hosts (regexReplaceAll "^https?://" .Values.appUrl "" | trimSuffix "/") }}
{{- end }}
{{- range .Values.extraAllowedHosts }}{{ $hosts = append $hosts . }}{{ end }}
{{- join "," $hosts }}
{{- end }}

{{/*
django-allauth's provider configuration, as PAPERLESS_SOCIALACCOUNT_PROVIDERS
reads it: one OpenID Connect app for the tenant's realm. server_url is the
discovery document, the form Paperless' own documentation gives.
*/}}
{{- define "paperless-ngx.socialaccountProviders" -}}
{{- $app := dict
      "provider_id" .Values.oidc.providerId
      "name" .Values.oidc.name
      "client_id" .Values.oidc.clientId
      "secret" .Values.oidc.clientSecret
      "settings" (dict
        "server_url" (printf "%s/.well-known/openid-configuration" (trimSuffix "/" .Values.oidc.issuer))
        "token_auth_method" "client_secret_basic"
        "oauth_pkce_enabled" true) }}
{{- $providers := dict "openid_connect" (dict
      "OAUTH_PKCE_ENABLED" true
      "SCOPE" .Values.oidc.scope
      "APPS" (list $app)) }}
{{- toJson $providers }}
{{- end }}
