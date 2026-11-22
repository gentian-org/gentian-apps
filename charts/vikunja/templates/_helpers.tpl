{{- define "vikunja.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "vikunja.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "vikunja.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "vikunja.labels" -}}
app.kubernetes.io/name: {{ include "vikunja.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "vikunja.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vikunja.name" . }}
{{- end }}

{{/*
Vikunja's whole configuration, as the config.yml it reads from
/etc/vikunja/. One file rather than VIKUNJA_* variables: the OpenID provider
is a map keyed by its id, which a file states plainly.
*/}}
{{- define "vikunja.config" -}}
{{- $config := dict
  "service" (dict
    "publicurl" (printf "%s/" (trimSuffix "/" .Values.appUrl))
    "interface" (printf ":%d" (int .Values.port))
    "secret" .Values.secret
    "timezone" .Values.timeZone
    "enableregistration" false
    "enableuserdeletion" false
    "enablecaldav" .Values.features.caldav
    "enablelinksharing" .Values.features.linkSharing
    "allowiconchanges" false)
  "database" (dict
    "type" "postgres"
    "host" (printf "%s:%v" .Values.database.host .Values.database.port)
    "database" .Values.database.name
    "user" .Values.database.user
    "password" .Values.database.password
    "sslmode" .Values.database.sslMode)
  "cors" (dict "enable" false)
  "files" (dict
    "type" "s3"
    "basepath" "files"
    "maxsize" .Values.files.maxSize
    "s3" (dict
      "endpoint" .Values.s3.endpoint
      "bucket" .Values.s3.bucket
      "region" .Values.s3.region
      "accesskey" .Values.s3.accessKeyId
      "secretkey" .Values.s3.secretAccessKey
      "usepathstyle" .Values.s3.forcePathStyle))
  "log" (dict "enabled" true "standard" "stdout" "http" "off" "level" .Values.logLevel)
  "sentry" (dict "enabled" false "frontendenabled" false)
  "webhooks" (dict "enabled" false)
  "backgrounds" (dict "enabled" true "providers" (dict "upload" (dict "enabled" true) "unsplash" (dict "enabled" false)))
  "migration" (dict
    "todoist" (dict "enable" false)
    "trello" (dict "enable" false)
    "microsofttodo" (dict "enable" false))
  "metrics" (dict "enabled" false)
  "plugins" (dict "enabled" false)
  "keyvalue" (dict "type" "memory")
  "defaultsettings" (dict
    "avatar_provider" "initials"
    "discoverable_by_name" .Values.defaultSettings.discoverableByName
    "discoverable_by_email" .Values.defaultSettings.discoverableByEmail
    "week_start" .Values.defaultSettings.weekStart
    "email_reminders_enabled" .Values.defaultSettings.emailReminders)
  "auth" (dict
    "local" (dict "enabled" false)
    "openid" (dict
      "enabled" .Values.oidc.enabled
      "providers" (dict .Values.oidc.providerId (dict
        "name" .Values.oidc.name
        "authurl" (trimSuffix "/" .Values.oidc.issuer)
        "clientid" .Values.oidc.clientId
        "clientsecret" .Values.oidc.clientSecret
        "scope" .Values.oidc.scope)))) }}
{{- if .Values.smtp.host }}
{{- $_ := set $config "mailer" (dict
    "enabled" true
    "host" .Values.smtp.host
    "port" (int .Values.smtp.port)
    "username" .Values.smtp.user
    "password" .Values.smtp.password
    "fromemail" .Values.smtp.fromAddress
    "forcessl" false) }}
{{- else }}
{{- $_ := set $config "mailer" (dict "enabled" false) }}
{{- end }}
{{- toYaml $config }}
{{- end }}
