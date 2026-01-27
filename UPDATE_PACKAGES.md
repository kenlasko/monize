# Package Update Guide

Your packages are from early 2024 and have some deprecation warnings. Here's how to update them:

## Option 1: Automatic Update (Recommended)

Run these commands to update all packages automatically:

### Backend Updates
```bash
cd /home/ken/moneymate/backend

# Update all packages to latest compatible versions
npm update

# Or update to latest major versions (more aggressive)
npm install @nestjs/common@latest @nestjs/core@latest @nestjs/platform-express@latest \
  @nestjs/config@latest @nestjs/typeorm@latest @nestjs/jwt@latest @nestjs/passport@latest \
  @nestjs/schedule@latest @nestjs/swagger@latest @nestjs/throttler@latest \
  typeorm@latest pg@latest redis@latest @nestjs/cache-manager@latest cache-manager@latest \
  passport@latest passport-jwt@latest passport-local@latest bcrypt@latest \
  class-validator@latest class-transformer@latest helmet@latest express-rate-limit@latest \
  uuid@latest axios@latest date-fns@latest nodemailer@latest reflect-metadata@latest rxjs@latest cron@latest

# Update dev dependencies
npm install -D @nestjs/cli@latest @nestjs/schematics@latest @nestjs/testing@latest \
  @types/express@latest @types/jest@latest @types/node@latest typescript@latest \
  eslint@latest prettier@latest jest@latest ts-jest@latest ts-node@latest
```

### Frontend Updates
```bash
cd /home/ken/moneymate/frontend

# Update all packages
npm update

# Or update to latest versions
npm install next@latest react@latest react-dom@latest axios@latest zustand@latest \
  react-hook-form@latest @hookform/resolvers@latest zod@latest date-fns@latest \
  recharts@latest react-icons@latest clsx@latest tailwind-merge@latest \
  @headlessui/react@latest @heroicons/react@latest react-hot-toast@latest js-cookie@latest

# Update dev dependencies
npm install -D @types/node@latest @types/react@latest @types/react-dom@latest \
  typescript@latest eslint@latest eslint-config-next@latest tailwindcss@latest \
  postcss@latest autoprefixer@latest @tailwindcss/forms@latest
```

## Option 2: Update Docker Images

Since you're using Docker, you can also update by rebuilding with latest packages:

```bash
cd /home/ken/moneymate

# Stop containers
docker compose down

# Remove old images
docker compose down --rmi all

# Rebuild with updates
docker compose build --no-cache

# Start fresh
docker compose up -d
```

## Option 3: Manual Package.json Updates

### Backend - Latest Versions (January 2026)

Replace the dependencies section in `backend/package.json`:

```json
"dependencies": {
  "@nestjs/common": "^10.4.15",
  "@nestjs/core": "^10.4.15",
  "@nestjs/platform-express": "^10.4.15",
  "@nestjs/config": "^3.3.0",
  "@nestjs/typeorm": "^10.0.2",
  "@nestjs/jwt": "^10.2.1",
  "@nestjs/passport": "^10.0.3",
  "@nestjs/schedule": "^4.1.1",
  "@nestjs/swagger": "^8.0.6",
  "@nestjs/throttler": "^6.2.2",
  "typeorm": "^0.3.20",
  "pg": "^8.13.1",
  "redis": "^4.7.0",
  "@nestjs/cache-manager": "^2.2.2",
  "cache-manager": "^5.7.6",
  "cache-manager-redis-store": "^3.0.1",
  "passport": "^0.7.0",
  "passport-jwt": "^4.0.1",
  "passport-local": "^1.0.0",
  "passport-openidconnect": "^0.1.1",
  "bcrypt": "^5.1.1",
  "class-validator": "^0.14.1",
  "class-transformer": "^0.5.1",
  "helmet": "^8.0.0",
  "express-rate-limit": "^7.4.1",
  "uuid": "^11.0.3",
  "axios": "^1.7.9",
  "date-fns": "^4.1.0",
  "nodemailer": "^6.9.16",
  "reflect-metadata": "^0.2.2",
  "rxjs": "^7.8.1",
  "@types/cron": "^2.4.0",
  "cron": "^3.2.0"
},
"devDependencies": {
  "@nestjs/cli": "^10.4.15",
  "@nestjs/schematics": "^10.2.3",
  "@nestjs/testing": "^10.4.15",
  "@types/express": "^5.0.0",
  "@types/jest": "^29.5.14",
  "@types/node": "^22.10.5",
  "@types/passport-jwt": "^4.0.1",
  "@types/passport-local": "^1.0.38",
  "@types/bcrypt": "^5.0.2",
  "@types/nodemailer": "^6.4.17",
  "@typescript-eslint/eslint-plugin": "^8.20.0",
  "@typescript-eslint/parser": "^8.20.0",
  "eslint": "^9.18.0",
  "eslint-config-prettier": "^9.1.0",
  "eslint-plugin-prettier": "^5.2.1",
  "jest": "^29.7.0",
  "prettier": "^3.4.2",
  "source-map-support": "^0.5.21",
  "supertest": "^7.0.0",
  "ts-jest": "^29.2.5",
  "ts-loader": "^9.5.1",
  "ts-node": "^10.9.2",
  "tsconfig-paths": "^4.2.0",
  "typescript": "^5.7.3"
}
```rfddddddddddddddcx

### Frontend - Latest Versions (January 2026)

Replace the dependencies section in `frontend/package.json`:

```json
"dependencies": {
  "next": "^15.1.6",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "axios": "^1.7.9",
  "zustand": "^5.0.3",
  "react-hook-form": "^7.54.2",
  "@hookform/resolvers": "^3.9.1",
  "zod": "^3.24.1",
  "date-fns": "^4.1.0",
  "recharts": "^2.15.0",
  "react-icons": "^5.4.0",
  "clsx": "^2.1.1",
  "tailwind-merge": "^2.5.5",
  "@headlessui/react": "^2.2.0",
  "@heroicons/react": "^2.2.0",
  "react-hot-toast": "^2.4.1",
  "js-cookie": "^3.0.5"
},
"devDependencies": {
  "@types/node": "^22.10.5",
  "@types/react": "^19.0.6",
  "@types/react-dom": "^19.0.2",
  "@types/js-cookie": "^3.0.6",
  "typescript": "^5.7.3",
  "eslint": "^9.18.0",
  "eslint-config-next": "^15.1.6",
  "tailwindcss": "^3.4.17",
  "postcss": "^8.4.49",
  "autoprefixer": "^10.4.20",
  "@tailwindcss/forms": "^0.5.9"
}
```

## After Updating

1. **Rebuild Docker images:**
   ```bash
   docker compose down
   docker compose build --no-cache
   docker compose up -d
   ```

2. **Or reinstall locally:**
   ```bash
   cd backend && rm -rf node_modules && npm install
   cd ../frontend && rm -rf node_modules && npm install
   ```

3. **Test everything:**
   - Check backend starts: `docker compose logs backend`
   - Check frontend starts: `docker compose logs frontend`
   - Open http://localhost:3001 and test the app

## Key Updates

### Backend Major Changes:
- **@nestjs/swagger**: v7 → v8 (improved OpenAPI support)
- **@nestjs/throttler**: v5 → v6 (better rate limiting)
- **helmet**: v7 → v8 (enhanced security headers)
- **uuid**: v9 → v11 (performance improvements)
- **date-fns**: v3 → v4 (better tree-shaking)
- **axios**: v1.6 → v1.7 (bug fixes)

### Frontend Major Changes:
- **next**: v14.1 → v15.1 (React 19 support, better performance)
- **react**: v18 → v19 (new features, concurrent rendering)
- **zustand**: v4 → v5 (improved TypeScript support)
- **@headlessui/react**: v1.7 → v2.2 (React 19 compatible)

## Breaking Changes to Watch

1. **React 19**: Some hooks behavior changed, check console warnings
2. **Next.js 15**: App Router improvements, check for deprecated patterns
3. **ESLint 9**: New config format (may need eslint.config.js instead of .eslintrc)

## Recommendation

For now, the current versions work fine. Update when you have time to test thoroughly. The deprecation warnings won't affect functionality.

If you want the latest features and security updates, use **Option 1** (automatic update) which is safest as it respects semver compatibility.
