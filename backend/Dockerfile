# Development stage
FROM node:20-alpine AS development

WORKDIR /app

# Install dependencies
COPY backend/package*.json ./
RUN npm install

# Copy source code
COPY backend/ .

# Copy schema.sql for db:init
COPY database/schema.sql ./schema.sql

# Build application
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy built application from development stage
COPY --from=development /app/dist ./dist

# Copy schema.sql for auto-initialization
COPY --from=development /app/schema.sql ./schema.sql

# Copy and prepare entrypoint script
COPY --from=development /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Create non-root user and set permissions
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 && \
    chmod +x ./docker-entrypoint.sh && \
    chown nestjs:nodejs ./docker-entrypoint.sh ./schema.sql

USER nestjs

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
