# Monize Helm Chart

A Helm chart for deploying the Monize personal finance application on Kubernetes.

## Architecture

Monize is a two-tier application:
- **Backend**: Node.js API server (port 3001) connected to a PostgreSQL database
- **Frontend**: Web application (port 3000) that communicates with the backend internally

Only the frontend is exposed externally via HTTPRoute or Ingress. The backend is accessible only within the cluster.

## Prerequisites

- Kubernetes 1.27+
- Helm 3.x
- Either a Gateway API implementation (e.g., Cilium) **or** an Ingress controller

## Installation

```bash
# Install with default values (HTTPRoute enabled)
helm install monize ./helm/monize -n monize --create-namespace

# Install with Ingress instead of HTTPRoute
helm install monize ./helm/monize -n monize --create-namespace \
  --set httpRoute.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx

# Dry-run to preview rendered templates
helm template monize ./helm/monize -n monize
```

## Routing Options

This chart supports two mutually exclusive routing strategies:

### HTTPRoute (Gateway API) - Default

Enabled by default. Uses the Kubernetes Gateway API with a Cilium TLS gateway.

```yaml
httpRoute:
  enabled: true
  parentRefs:
    - name: tls
      namespace: cilium
      sectionName: https
```

### Ingress (Traditional)

For clusters using a traditional Ingress controller (nginx, traefik, etc.):

```yaml
httpRoute:
  enabled: false

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    - secretName: monize-tls
      hosts:
        - monize.yourdomain.com
```

> **Note**: Both can technically be enabled simultaneously, but it is recommended to only enable one.

## Configuration

### Global Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `global.namespace` | Namespace for all resources | `monize` |
| `global.domain` | Application domain | `yourdomain.com` |
| `global.hostname` | Full hostname override | `monize.<domain>` |
| `global.timezone` | Container timezone | `America/Toronto` |
| `global.priorityClassName` | Pod priority class | `low-priority` |

### Namespace

| Parameter | Description | Default |
|-----------|-------------|---------|
| `namespace.create` | Create the namespace | `true` |
| `namespace.podSecurityEnforce` | Pod Security Standard level | `restricted` |

### Backend

| Parameter | Description | Default |
|-----------|-------------|---------|
| `backend.image.registry` | Image registry | `registry.yourdomain.com` |
| `backend.image.repository` | Image repository | `monize/backend` |
| `backend.image.tag` | Image tag | `latest` |
| `backend.image.pullPolicy` | Image pull policy | `Always` |
| `backend.replicas` | Number of replicas | `1` |
| `backend.service.port` | Service port | `3001` |
| `backend.service.type` | Service type | `ClusterIP` |
| `backend.resources` | CPU/memory requests and limits | See values.yaml |
| `backend.securityContext` | Container security context | Restricted (non-root, read-only fs) |
| `backend.livenessProbe` | Liveness probe config | `/api/v1/health/live` |
| `backend.readinessProbe` | Readiness probe config | `/api/v1/health/ready` |
| `backend.env.*` | Backend environment variables | See values.yaml |

### Frontend

| Parameter | Description | Default |
|-----------|-------------|---------|
| `frontend.image.registry` | Image registry | `registry.yourdomain.com` |
| `frontend.image.repository` | Image repository | `monize/frontend` |
| `frontend.image.tag` | Image tag | `latest` |
| `frontend.image.pullPolicy` | Image pull policy | `Always` |
| `frontend.replicas` | Number of replicas | `1` |
| `frontend.service.port` | Service port | `3000` |
| `frontend.service.type` | Service type | `ClusterIP` |
| `frontend.resources` | CPU/memory requests and limits | See values.yaml |
| `frontend.securityContext` | Container security context | Restricted (non-root, read-only fs) |
| `frontend.livenessProbe` | Liveness probe config | `/api/v1/health/live` |
| `frontend.readinessProbe` | Readiness probe config | `/api/v1/health/ready` |
| `frontend.env.*` | Frontend environment variables | See values.yaml |

## Security

All containers enforce the `restricted` Pod Security Standard:
- Run as non-root user (UID 1000)
- Read-only root filesystem
- All Linux capabilities dropped
- RuntimeDefault seccomp profile
- No privilege escalation

## Testing

```bash
# Lint the chart
helm lint ./helm/monize

# Render templates without deploying
helm template monize ./helm/monize -n monize

# Dry-run install
helm install monize ./helm/monize -n monize --dry-run

# Test with Ingress instead of HTTPRoute
helm template monize ./helm/monize -n monize \
  --set httpRoute.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx
```
