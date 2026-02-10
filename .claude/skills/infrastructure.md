# Infrastructure & DevOps

## Docker Setup

### Development (`docker-compose.yml`)
Three services:
- **db:** PostgreSQL 16 (port 5432), volume `postgres_data`, init script at `database/init.sql`
- **backend:** NestJS (port 3001), hot-reload via volume mount `./backend:/app` with anonymous `/app/node_modules`
- **frontend:** Next.js (port 3000), hot-reload via volume mount `./frontend:/app` with anonymous `/app/.next` and `/app/node_modules`

Frontend proxies `/api/v1/*` to backend at `INTERNAL_API_URL=http://backend:3001`.

### Production (`docker-compose.prod.yml`)
Same three services but:
- Backend/frontend use multi-stage Dockerfiles (build + runtime stages)
- No volume mounts (built artifacts only)
- Frontend uses `output: 'standalone'` for minimal Docker image
- Health checks on all services

### Dockerfiles
- **`backend/Dockerfile`:** Multi-stage, copies `dist/`, `node_modules`, `docker-entrypoint.sh`
- **`frontend/Dockerfile`:** Multi-stage, copies `.next/standalone`, `.next/static`, `public`

### Docker Entrypoint (backend)
```sh
node dist/db-init.js    # Run database initialization/migrations
exec node dist/main.js  # Start NestJS
```

## Database

### Schema (`database/init.sql`)
Core SQL schema that creates all tables, indexes, triggers, and the `update_updated_at_column()` function. This is the source of truth for the database schema.

### Migrations (`database/migrations/`)
Incremental SQL files using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` pattern:
- `001_add_loan_account_fields.sql` - Loan columns on accounts
- `002_add_category_to_transactions.sql`
- `002_add_transfer_account_to_scheduled_splits.sql`
- `003_add_scheduled_transaction_transfer_support.sql`
- `004_add_asset_account_type.sql`
- `005_add_mortgage_account_fields.sql`
- `006_add_getting_started_dismissed.sql`
- `007_add_password_reset_fields.sql`
- `008_add_user_roles.sql`
- `009_add_two_factor_secret.sql`
- `010_add_trusted_devices.sql` - Creates trusted_devices table
- `011_add_user_id_to_securities.sql` - Multi-tenant securities
- Plus several unnumbered early migrations

Migrations run via `db-init.js` at container startup. Always update `schema.sql` alongside migrations.

### Seeding
- `backend/src/database/` contains seeding logic
- Default categories (130+) imported on first use via `/categories/import-defaults`
- Demo data available for development

## Environment Configuration

### `.env` (development)
```
POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
JWT_SECRET (min 32 chars)
NODE_ENV=development
PUBLIC_APP_URL=http://localhost:3000
```

### `.env.docker` (Docker overrides)
```
DATABASE_HOST=db (container name)
INTERNAL_API_URL=http://backend:3001
```

### `.env.prod` (production)
```
NODE_ENV=production
```

### Key environment variables
| Variable | Used By | Purpose |
|---|---|---|
| `DATABASE_HOST/PORT/USER/PASSWORD/DB` | Backend | PostgreSQL connection |
| `JWT_SECRET` | Backend | Token signing (min 32 chars) |
| `INTERNAL_API_URL` | Frontend | Backend proxy target |
| `PUBLIC_APP_URL` | Both | External URL for emails/redirects |
| `NODE_ENV` | Both | development/production mode |
| `NEXT_PUBLIC_LOG_LEVEL` | Frontend | Client-side log level |
| `OIDC_*` | Backend | OIDC provider config (optional) |
| `SMTP_*` | Backend | Email config (optional) |

## E2E Testing (`e2e/`)

### Framework
- **Playwright** with Chromium
- Config at `e2e/playwright.config.ts`
- `BASE_URL` defaults to `http://localhost:3000`

### Test Structure
```
e2e/
  tests/
    auth.spec.ts           # Login, register, logout flows
    accounts.spec.ts       # Account CRUD
    transactions.spec.ts   # Transaction CRUD, filters
    categories.spec.ts     # Category management
    ... (per-feature test files)
  playwright.config.ts
  package.json
```

### Running E2E tests
```bash
cd e2e
npm install
npx playwright install --with-deps chromium
npx playwright test --project=chromium
```
Requires all Docker services running (`docker compose up -d`).

## CI/CD (`.github/workflows/ci.yml`)

### Pipeline stages
1. **Backend Unit Tests** - `cd backend && npm ci && npm test`
2. **Frontend Unit Tests** - `cd frontend && npm ci && npm test`
3. **E2E Tests** (depends on both above) - Starts Docker Compose, waits for health, runs Playwright

### Artifacts uploaded
- `backend-coverage/`, `frontend-coverage/`, `e2e-report/`

## Development Workflow

### Starting dev environment
```bash
docker compose up -d              # Start all services
docker compose logs -f frontend   # Watch frontend logs
docker compose logs -f backend    # Watch backend logs
```

### Rebuilding after dependency changes
```bash
docker compose down
docker compose up -d --build
```

### Running tests
```bash
# Backend unit tests
cd backend && npm test

# Frontend unit tests
cd frontend && npm test

# E2E tests (services must be running)
cd e2e && npx playwright test
```

### Database access
```bash
docker compose exec db psql -U monize_user -d monize
```

## Network Architecture (Development)
```
Browser :3000 --> Next.js Frontend --> proxy.ts --> Backend :3001 --> PostgreSQL :5432
                  (Docker: frontend)                (Docker: backend) (Docker: db)
```

All API calls go through the frontend proxy. The browser never talks to the backend directly. This simplifies CORS, cookies, and CSP.
