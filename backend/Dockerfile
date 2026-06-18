# Development stage
FROM node:24-alpine AS development

WORKDIR /app

# Install dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy source code
COPY backend/ .

# Copy schema.sql for db-init and migrations for db-migrate
COPY database/schema.sql ./schema.sql
COPY database/migrations ./migrations

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Builder stage (uses slim/glibc to avoid Alpine musl stalling under QEMU arm64 emulation)
FROM node:24-slim AS builder

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci

COPY backend/ .

# Copy schema.sql and migrations (needed by production stage)
COPY database/schema.sql ./schema.sql
COPY database/migrations ./migrations

RUN npm run build

# Production deps stage (uses slim/glibc to avoid Alpine musl SIGILL under QEMU)
FROM node:24-slim AS deps

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Production stage
FROM node:24-alpine AS production
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

# Install dumb-init for proper PID 1 signal handling. Drop the npm/npx/corepack
# CLI bundled in the base image: the entrypoint and app run via `node dist/*.js`,
# so npm is never used at runtime, and its vendored deps (tar, ip-address,
# brace-expansion) otherwise surface as image CVEs we cannot patch directly.
RUN apk add --no-cache dumb-init && \
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

# Copy and prepare entrypoint script
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Create non-root user and set permissions
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 && \
    chmod +x ./docker-entrypoint.sh && \
    chown nestjs:nodejs ./docker-entrypoint.sh ./schema.sql && \
    chown -R nestjs:nodejs ./migrations

USER nestjs

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["./docker-entrypoint.sh"]
