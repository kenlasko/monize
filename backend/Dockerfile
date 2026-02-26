# Development stage
FROM node:20-alpine AS development

WORKDIR /app

# Install dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy source code
COPY backend/ .

# Copy schema.sql for db-init and migrations for db-migrate
COPY database/schema.sql ./schema.sql
COPY database/migrations ./migrations

# Build application
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Production deps stage (uses slim/glibc to avoid Alpine musl SIGILL under QEMU)
FROM node:20-slim AS deps

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Production stage
FROM node:20-alpine AS production
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

# Install dumb-init for proper PID 1 signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package*.json ./

# Copy built application from development stage (strip source maps)
COPY --from=development /app/dist ./dist
RUN find ./dist -name '*.js.map' -delete

# Copy schema.sql and migrations for auto-initialization
COPY --from=development /app/schema.sql ./schema.sql
COPY --from=development /app/migrations ./migrations

# Copy and prepare entrypoint script
COPY --from=development /app/docker-entrypoint.sh ./docker-entrypoint.sh

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
