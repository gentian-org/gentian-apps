{{- define "erpnext.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "erpnext.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "erpnext.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "erpnext.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end }}

{{- define "erpnext.redisImage" -}}
{{ .Values.redis.image.repository }}:{{ .Values.redis.image.tag }}
{{- end }}

{{- define "erpnext.siteName" -}}
{{- required "siteName is required: the host the site is served at" .Values.siteName -}}
{{- end }}

{{/* What every Frappe container is told: the site, and where the pod's Redis listen. */}}
{{- define "erpnext.env" -}}
- name: FRAPPE_SITE
  value: {{ include "erpnext.siteName" . | quote }}
- name: REDIS_CACHE_PORT
  value: {{ .Values.redis.cache.port | quote }}
- name: REDIS_QUEUE_PORT
  value: {{ .Values.redis.queue.port | quote }}
# The mariadb client Frappe runs to load, dump and restore the database reads
# its options from $MYSQL_HOME/my.cnf (templates/configmap.yaml).
- name: MYSQL_HOME
  value: /gentian
{{- with .Values.extraEnvVars }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* The volumes every Frappe container mounts. */}}
{{- define "erpnext.mounts" -}}
- name: sites
  mountPath: /home/frappe/frappe-bench/sites
- name: logs
  mountPath: /home/frappe/frappe-bench/logs
- name: scripts
  mountPath: /gentian
  readOnly: true
{{- with .Values.extraVolumeMounts }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* How nginx hands a request to Frappe's web server. */}}
{{- define "erpnext.backendProxy" -}}
proxy_http_version 1.1;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Frappe-Site-Name {{ include "erpnext.siteName" . }};
proxy_set_header Host $host;
proxy_set_header X-Use-X-Accel-Redirect True;
proxy_read_timeout {{ .Values.nginx.proxyReadTimeout }};
proxy_redirect off;
proxy_pass http://backend-server;
{{- end }}
