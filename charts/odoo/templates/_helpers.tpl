{{- define "odoo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "odoo.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "odoo.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- /*
odoo.image — the Odoo image reference, by digest when one is given.

A digest is the only immutable reference this image has: ghcr.io/gentian-org/ocb
publishes exactly two tags, "main" and "latest", and both move. A tag therefore
says nothing about which build a pod runs, and a pod that restarts pulls whatever
"latest" points at that minute — so the same tenant can silently change Odoo
version between two restarts, with nothing in the manifest recording it.

image.digest wins when set; image.tag remains the fallback so a local or
development install can still track a moving tag deliberately.
*/}}
{{- define "odoo.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}
{{- end }}
