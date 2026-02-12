{{/*
Expand the name of the chart.
*/}}
{{- define "monize.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "monize.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chart label values.
*/}}
{{- define "monize.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve the application hostname.
Defaults to monize.<global.domain>
*/}}
{{- define "monize.hostname" -}}
{{- if .Values.global.hostname }}
{{- .Values.global.hostname }}
{{- else }}
{{- printf "monize.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Resolve the public app URL.
Defaults to https://<hostname>
*/}}
{{- define "monize.publicAppUrl" -}}
{{- printf "https://%s" (include "monize.hostname" .) }}
{{- end }}

{{/*
Resolve the OIDC issuer URL.
Defaults to https://auth.<global.domain>
*/}}
{{- define "monize.oidcIssuerUrl" -}}
{{- if .Values.backend.oidc.OIDC_ISSUER_URL }}
{{- .Values.backend.oidc.OIDC_ISSUER_URL }}
{{- else }}
{{- printf "https://auth.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Resolve the OIDC callback URL.
Defaults to https://<hostname>/api/v1/auth/oidc/callback
*/}}
{{- define "monize.oidcCallbackUrl" -}}
{{- if .Values.backend.oidc.OIDC_CALLBACK_URL }}
{{- .Values.backend.oidc.OIDC_CALLBACK_URL }}
{{- else }}
{{- printf "https://%s/api/v1/auth/oidc/callback" (include "monize.hostname" .) }}
{{- end }}
{{- end }}

{{/*
Resolve the internal API URL for the frontend.
Defaults to http://monize-backend-service:<backend.service.port>
*/}}
{{- define "monize.internalApiUrl" -}}
{{- if .Values.frontend.app.INTERNAL_API_URL }}
{{- .Values.frontend.app.INTERNAL_API_URL }}
{{- else }}
{{- printf "http://monize-backend-service:%v" (.Values.backend.service.port | int) }}
{{- end }}
{{- end }}

{{/*
Common labels for backend resources.
*/}}
{{- define "monize.backend.labels" -}}
app: monize-backend
app.kubernetes.io/name: monize-backend
app.kubernetes.io/version: {{ .Values.backend.image.tag | quote }}
app.kubernetes.io/component: backend
app.kubernetes.io/part-of: monize
helm.sh/chart: {{ include "monize.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for backend.
*/}}
{{- define "monize.backend.selectorLabels" -}}
app: monize-backend
{{- end }}

{{/*
Common labels for frontend resources.
*/}}
{{- define "monize.frontend.labels" -}}
app: monize-frontend
app.kubernetes.io/name: monize-frontend
app.kubernetes.io/version: {{ .Values.frontend.image.tag | quote }}
app.kubernetes.io/component: frontend
app.kubernetes.io/part-of: monize
helm.sh/chart: {{ include "monize.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for frontend.
*/}}
{{- define "monize.frontend.selectorLabels" -}}
app: monize-frontend
{{- end }}
