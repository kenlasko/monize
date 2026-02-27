# Monize

Personal finance management app (Microsoft Money replacement). NestJS backend, Next.js frontend, PostgreSQL database, all running in Docker.

## Tech Stack

| Layer | Tech | Version |
|-------|------|---------|
| Backend | NestJS + TypeORM | 11.x, TS 5.9 |
| Frontend | Next.js (App Router) + React | 16.x, React 19 |
| Database | PostgreSQL | 16 |
| Styling | Tailwind CSS | 4.x |
| State | Zustand (frontend), class-validator DTOs (backend) |
| Forms | react-hook-form + Zod (frontend), class-validator (backend) |
| Auth | JWT + Passport + OIDC + TOTP 2FA |
| AI | Anthropic SDK, OpenAI SDK, Ollama (user-configurable) |
| Testing | Jest (backend), Vitest (frontend), Playwright (e2e) |

## Commands

```bash
# Everything runs in Docker
docker compose -f docker-compose.dev.yml up

# Backend (from /backend)
npm run start:dev          # Dev server with HMR
npm run test               # All tests
npm run test:unit          # Unit tests only
npm run test:cov           # Coverage report (80% minimum)
npm run lint               # ESLint --fix
npm run build              # Production build

# Frontend (from /frontend)
npm run dev                # Dev server (port 3001)
npm run test               # Vitest
npm run test:cov           # Coverage (65% lines minimum)
npm run type-check         # tsc --noEmit
npm run lint

# E2E (from /e2e)
npm run test               # Playwright
```

## Project Structure

```
backend/src/
  {feature}/
    {feature}.module.ts
    {feature}.controller.ts
    {feature}.service.ts
    entities/{entity}.entity.ts
    dto/create-{entity}.dto.ts
    dto/update-{entity}.dto.ts
    {feature}.service.spec.ts
    {feature}.controller.spec.ts
  common/                    # Shared guards, pipes, decorators, utils
  auth/                      # JWT, OIDC, 2FA, PATs, refresh tokens
  ai/                        # AI providers, query engine, MCP server

frontend/src/
  app/                       # Next.js App Router pages
  components/{feature}/      # Feature-organized React components
  lib/                       # API clients (axios), utilities
  hooks/                     # Custom React hooks
  store/                     # Zustand stores (auth, preferences, demo)
  types/                     # Shared TypeScript interfaces

database/
  schema.sql                 # Complete schema (for fresh installs)
  migrations/                # Incremental SQL migrations (auto-applied on startup)
```

## Critical Rules

### Code Organization
- Many small files over few large files (200-400 lines typical, 800 max)
- Organize by feature/domain, not by type
- Always update `database/schema.sql` alongside any migration

### Code Style
- No emojis in code, comments, or documentation
- Immutability always -- never mutate objects or arrays
- No `console.log` in production code; use NestJS `Logger` class
- Use proxy, not middleware (middleware is deprecated in this project)

### Security (Do Not Regress)
- Parameterized queries only (TypeORM QueryBuilder or parameterized raw SQL). Never interpolate user input into SQL strings
- All controllers use `@UseGuards(AuthGuard('jwt'))` at class level (except health + auth)
- All service methods derive `userId` from JWT (`req.user.id`), never from request params/body
- All path `:id` params use `ParseUUIDPipe`
- DTOs use `whitelist: true` + `forbidNonWhitelisted: true`
- All user-controlled values in HTML email templates must use `escapeHtml()`
- API keys encrypted with AES-256-GCM before storage, never returned to client
- CSRF double-submit cookie pattern is global; use `@SkipCsrf()` only for non-cookie auth (e.g., PAT bearer)

## Backend Patterns

### NestJS Module Pattern

Every feature follows this structure:

```typescript
// controller -- thin, delegates to service
@Controller('feature')
@UseGuards(AuthGuard('jwt'))
export class FeatureController {
  constructor(private featureService: FeatureService) {}

  @Post()
  create(@Request() req, @Body() dto: CreateFeatureDto) {
    return this.featureService.create(req.user.id, dto);
  }

  @Get(':id')
  findOne(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return this.featureService.findOne(req.user.id, id);
  }
}

// service -- all business logic, always takes userId as first param
@Injectable()
export class FeatureService {
  private readonly logger = new Logger(FeatureService.name);

  constructor(
    @InjectRepository(Feature)
    private repo: Repository<Feature>,
    private dataSource: DataSource,
  ) {}

  async create(userId: string, dto: CreateFeatureDto): Promise<Feature> {
    // Always filter by userId for multi-tenancy
  }
}
```

### QueryRunner Transactions (CRITICAL)

Any operation that touches multiple tables or does read-modify-write MUST use a QueryRunner. This is the most common source of bugs in this codebase.

```typescript
async createSomething(userId: string, dto: CreateDto) {
  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    // All DB operations use queryRunner.manager instead of this.repo
    const entity = queryRunner.manager.create(Entity, { ...dto, userId });
    await queryRunner.manager.save(entity);
    await this.updateBalance(accountId, amount, queryRunner);

    await queryRunner.commitTransaction();
    return entity;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}
```

Operations that already use QueryRunner correctly: `create()` and `createTransfer()` in transactions, investment transaction CRUD, transfer CRUD, holdings rebuild.

Operations that still need it (see AUDIT_FINDINGS.md): `update()`, `remove()`, split operations, bulk updates.

### Financial Math

All money values are stored as `decimal(20,4)` in PostgreSQL. In JavaScript, always round to avoid floating-point drift:

```typescript
// WRONG: floating-point accumulation
const total = items.reduce((sum, item) => sum + item.amount, 0);

// RIGHT: integer arithmetic
const totalCents = items.reduce(
  (sum, item) => sum + Math.round(Number(item.amount) * 10000), 0
);
const total = totalCents / 10000;

// For simple rounding
const rounded = Math.round(value * 10000) / 10000;
```

Balance updates use atomic SQL: `UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2`.

### DTO Validation

Backend uses `class-validator`. Frontend uses Zod.

```typescript
// Backend DTO example
export class CreateTransactionDto {
  @IsUUID()
  accountId: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsDateString()
  transactionDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  memo?: string;
}
```

Always include: `@MaxLength` on strings, `@Min`/`@Max` on numbers, `@IsUUID` on ID references, `@SanitizeHtml()` on user-facing text fields.

## Frontend Patterns

### API Clients

All API calls go through typed axios clients in `frontend/src/lib/`:

```typescript
// lib/transactionsApi.ts
export const transactionsApi = {
  getAll: (params) => api.get<Transaction[]>('/transactions', { params }),
  create: (data) => api.post<Transaction>('/transactions', data),
};
```

The SSR proxy in `frontend/src/proxy.ts` handles auth cookie forwarding. Use proxy, not Next.js middleware.

### React Testing (act() Pattern)

Components with async `useEffect` (API calls on mount) MUST use this pattern to avoid act() warnings:

```typescript
async function renderMyComponent() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MyComponent />);
  });
  return result!;
}

// Use in every test
it('renders data', async () => {
  const { getByText } = await renderMyComponent();
  expect(getByText('Expected')).toBeInTheDocument();
});
```

Wrap user interactions that trigger async state updates: `await act(async () => { fireEvent.click(button); });`

### State Management

Three Zustand stores in `frontend/src/store/`:
- `authStore` -- user, isAuthenticated, login/logout
- `preferencesStore` -- defaultCurrency, dateFormat, theme
- `demoStore` -- demo mode state

## Database

- Schema: `database/schema.sql` (complete, for fresh installs)
- Migrations: `database/migrations/NNN_description.sql` (incremental, auto-applied on startup via `db-migrate.ts`)
- Both must stay in sync -- any migration must also update schema.sql
- All migrations use `IF NOT EXISTS` / `IF EXISTS` for idempotency
- Column naming: `snake_case` in SQL, `camelCase` in TypeORM entities via `@Column({ name: 'snake_case' })`

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- minimum 32 chars, enforced at startup
- `AI_ENCRYPTION_KEY` -- minimum 32 chars, for API key encryption
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config

## Pending Work

See `AUDIT_FINDINGS.md` for the complete audit backlog with prioritized fix phases. Key items:
- [ ] openid-client v5 to v6 migration (v5 EOL April 30, 2026)
- [ ] Wrap remaining write operations in QueryRunner transactions
- [ ] Standardize financial math with integer arithmetic utility
- [ ] UTC consistency for all date comparisons in crons and budget periods
