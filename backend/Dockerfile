# Development stage
FROM mirror.gcr.io/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS development

WORKDIR /app

# Install dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy source code
COPY backend/ .

# Copy schema.sql for db-init and migrations for db-migrate
COPY database/schema.sql ./schema.sql
COPY database/migrations ./migrations

# Copy release notes so the What's New digest can be served without network access
COPY docs/release-notes ./release-notes

# Copy the user guide so in-app help works without network access (no images)
COPY website/docs/*.md website/docs/nav.json website/docs/search-index.json ./help/

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Builder stage (uses slim/glibc to avoid Alpine musl stalling under QEMU arm64 emulation)
FROM mirror.gcr.io/library/node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci

COPY backend/ .

# Copy schema.sql and migrations (needed by production stage)
COPY database/schema.sql ./schema.sql
COPY database/migrations ./migrations

# Copy release notes (needed by production stage for the What's New digest)
COPY docs/release-notes ./release-notes

# Copy the user guide (needed by production stage for in-app help; no images)
COPY website/docs/*.md website/docs/nav.json website/docs/search-index.json ./help/

# `nest build` type-checks the whole backend in one tsc process, which now
# needs more than the ~2 GB heap Node defaults to on an 8 GB host (WSL,
# Docker Desktop). CI runners default higher, so only local builds hit it.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# Production deps stage (uses slim/glibc to avoid Alpine musl SIGILL under QEMU)
FROM mirror.gcr.io/library/node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS deps

WORKDIR /app

COPY backend/package*.json ./
# --libc=musl: these node_modules run on the Alpine production stage, so any
# libc-specific optional binary must be the musl build, not the glibc one this
# stage would pick natively.
RUN npm ci --omit=dev --libc=musl && npm cache clean --force

# Production stage
FROM mirror.gcr.io/library/node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS production
ARG GIT_SHA
ARG BUILD_DATE
ARG VERSION
LABEL org.opencontainers.image.title="Monize Backend" \
      org.opencontainers.image.description="Backend for Monize, a self-hosted personal finance app" \
      org.opencontainers.image.source="https://github.com/kenlasko/monize" \
      org.opencontainers.image.url="https://github.com/kenlasko/monize" \
      org.opencontainers.image.authors="ken.lasko@gmail.com" \
      org.opencontainers.image.vendor="Ken Lasko" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${VERSION}"

# Upgrade the base image's OS packages before anything else. `node:24-alpine`
# is rebuilt on Node's cadence, not Alpine's, so between rebuilds it ships
# whatever libcrypto3/libssl3 was current when the tag was cut -- that lag is
# the whole of this repository's open Trivy alerts, and it recurs every time
# Alpine publishes an OpenSSL advisory. Upgrading at build time takes the
# fixed packages from the same Alpine branch the base image already pins, so
# each rebuild clears the class rather than the ten CVEs that happen to be
# open today. `ignore-unfixed: true` on the scan means an alert that survives
# this is one Alpine has no fix for, and is genuinely ours to wait out.
#
# Install dumb-init for proper PID 1 signal handling. Drop the npm/npx/corepack
# CLI bundled in the base image: the entrypoint and app run via `node dist/*.js`,
# so npm is never used at runtime, and its vendored deps (tar, ip-address,
# brace-expansion) otherwise surface as image CVEs we cannot patch directly.
RUN apk upgrade --no-cache && \
    apk add --no-cache dumb-init && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

ENV NODE_ENV=production

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package*.json ./

# Copy built application from builder stage (strip source maps)
COPY --from=builder /app/dist ./dist
RUN find ./dist -name '*.js.map' -delete

# Copy schema.sql and migrations for auto-initialization
COPY --from=builder /app/schema.sql ./schema.sql
COPY --from=builder /app/migrations ./migrations

# Copy release notes for the What's New digest
COPY --from=builder /app/release-notes ./release-notes

# Copy the user guide for in-app help
COPY --from=builder /app/help ./help

# Copy and prepare entrypoint script
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Create non-root user and set permissions
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 && \
    chmod +x ./docker-entrypoint.sh && \
    chown nestjs:nodejs ./docker-entrypoint.sh ./schema.sql && \
    chown -R nestjs:nodejs ./migrations ./release-notes ./help

USER nestjs

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["./docker-entrypoint.sh"]
