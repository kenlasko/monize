# Monize

Personal finance management app (Microsoft Money replacement). NestJS backend, Next.js frontend, PostgreSQL database, all running in Docker/Kubernetes

See `backend/CLAUDE.md`, `frontend/CLAUDE.md`, and `database/CLAUDE.md` for layer-specific details (commands, structure, conventions).

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
| i18n | next-intl (frontend), nestjs-i18n (backend) -- locales: `de`, `en`,`en-US`, `en-CA`, `en-GB`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, `xx` (pseudo) |
| Testing | Jest (backend), Vitest (frontend), Playwright (e2e) |

Everything runs in Docker: `docker compose -f docker-compose.dev.yml up`.

## Critical Rules

### Code Organization
- Many small files over few large files (200-400 lines typical, 800 max)
- Organize by feature/domain, not by type
- Always update `database/schema.sql` alongside any migration
- Always create tests for any new functionality added

### Shared AI tools (AI Assistant + MCP server)
- Every AI tool that reads or aggregates data must share its implementation between the AI Assistant (`backend/src/ai/query/tool-executor.service.ts`) and the MCP server (`backend/src/mcp/tools/*.tool.ts`).
- Put the shared logic on the relevant domain service (e.g., `PortfolioService.getLlmSummary`, `TransactionAnalyticsService.getTransfersByAccount`). The two tool layers become thin adapters that call it.
- Both surfaces must return the same data shape. The AI tool executor wraps it with `{ summary, sources }`; MCP just `toolResult(data)`s it.
- Adding a new AI tool means wiring it into both layers in the same PR -- never ship a tool to only one of the two.

### Internationalization (i18n)
Every user-facing string must be internationalized -- no hardcoded literals in toasts, labels, placeholders, validation messages, or emails. Develop **English-first**: while a change is under development and review, add and edit only the English catalogs and regenerate the pseudo-locale; defer translating the other locales until the code and its copy are functionally accepted. A feature is not *merged* until it is fully internationalized and translated for every supported locale, but that full translation is a single pass done at acceptance as the final commit on the same PR, not continuous work throughout development.
- **Frontend** (`next-intl`): read strings via `useTranslations('namespace')`; catalogs live in `frontend/src/i18n/messages/{locale}/{namespace}.json` (register new namespaces in `src/i18n/messages.ts`). Use `t.rich` for embedded markup and `t.raw` for template strings.
- **Backend** (`nestjs-i18n`): wrap exception messages in `tr(key, fallback, args)`; render emails with an `EmailT` translator (`emailTranslator(i18n, recipientLang)`) so copy matches the recipient's stored locale, not the request's. Catalogs live in `backend/src/i18n/locales/{locale}/*.json`.
- **Supported locales** are defined in `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts` -- keep the two lists in sync. Currently `de` (German), `en` (English -- Canadian-flavoured base), `en-US` (American English), `en-CA` (Canadian English), `en-GB` (British English), `es` (Spanish), `fr` (French), `hi` (Hindi), `id` (Indonesian), `it` (Italian), `ja` (Japanese), `ko` (Korean), `nl` (Dutch), `pl` (Polish), `pt` (Portuguese), `pt-BR` (Brazilian Portuguese), `ru` (Russian), `tr` (Turkish), `uk` (Ukrainian), `vi` (Vietnamese), `zh-CN` (Simplified Chinese), `zh-TW` (Traditional Chinese), and `xx` (dev-only pseudo-locale for QA). The `en-*` variants are lean regional variants (see their `base` in config): each ships only the strings that differ from `en` and inherits the rest per key.
- **During development, edit only the English catalogs (`en/*`)** -- do not hand-translate the other locales while the copy is still in flux. Once the change is functionally accepted, run one localization pass that fills every locale. Parity tests (`frontend/src/i18n/messages.parity.test.ts`, `backend/src/i18n/locales.parity.spec.ts`) fail when a locale is missing a key or references a placeholder `en` does not supply -- on a work-in-progress branch that failure is expected until the localization pass, and is not a reason to translate early. `main` still requires full parity, so released code is never partially translated.
- After editing any `en/*.json`, regenerate the pseudo-locale: `npm run i18n:pseudo` (CI enforces freshness via `npm run i18n:check`).
- The user's language lives in `user_preferences.language` and is chosen in Settings -> Preferences (`LanguageSelector`); unauthenticated screens offer `AuthLanguageSwitcher` (cookie-only) on login/register. See `frontend/src/i18n/messages/README.md` and `backend/src/i18n/README.md` for the full contributor flow.

### Code Style
- No emojis in code, comments, or documentation
- Immutability always -- never mutate objects or arrays
- No `console.log` in production code; use NestJS `Logger` class
- Use proxy, not middleware (middleware is deprecated in this project)

### Code Intelligence
Prefer LSP over Grep/Read for code navigation — it's faster, precise, and avoids reading entire files:
- `workspaceSymbol` to find where something is defined
- `findReferences` to see all usages across the codebase
- `goToDefinition` / `goToImplementation` to jump to source
- `hover` for type info without reading the file

Use Grep only when LSP isn't available or for text/pattern searches (comments, strings, config).

After writing or editing code, check LSP diagnostics and fix errors before proceeding.

### Security (Do Not Regress)
- Parameterized queries only (TypeORM QueryBuilder or parameterized raw SQL). Never interpolate user input into SQL strings
- All controllers use `@UseGuards(AuthGuard('jwt'))` at class level (except health + auth)
- All service methods derive `userId` from JWT (`req.user.id`), never from request params/body
- All path `:id` params use `ParseUUIDPipe`
- DTOs use `whitelist: true` + `forbidNonWhitelisted: true`, with `@MaxLength` on strings, `@Min`/`@Max` on numbers, `@IsUUID` on ID references, `@SanitizeHtml()` on user-facing text fields
- All user-controlled values in HTML email templates must use `escapeHtml()`
- API keys encrypted with AES-256-GCM before storage, never returned to client
- CSRF double-submit cookie pattern is global; use `@SkipCsrf()` only for non-cookie auth (e.g., PAT bearer)

## QueryRunner Transactions (CRITICAL)

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

Operations that correctly use QueryRunner: in the transactions domain, `create()`, `update()`, `remove()`, transfers, splits, and bulk update/delete; plus investment transaction CRUD and holdings rebuild. The split, bulk, transfer, and reconciliation flows live in dedicated `transaction-*.service.ts` files, each managing its own QueryRunner. This is the pattern **existing** code follows while the Row-Level Security migration is in progress; **new** DB access must use `tenantTx` instead (see below).

## Database Access & Row-Level Security (RLS ratchet — CRITICAL)

All **new** database access must go through `tenantTx` (`backend/src/common/db/tenant-tx.ts`) — the single RLS-compliant door to the DB. **Do not add new `@InjectRepository(...)` fields or `this.dataSource.createQueryRunner()` calls.** A CI ratchet (`backend/scripts/rls-ratchet.mjs`, baseline `backend/scripts/rls-ratchet-baseline.json`) counts every `@InjectRepository(` and `createQueryRunner(` site under `src/`; the counts **may only decrease**, so adding either fails "Backend Lint & Type Check". The ~87 existing injected repos / QueryRunners are being migrated module-by-module behind `RLS_MODE=off`; converting one lets you lower the baseline.

```typescript
// Read: one short tenant transaction, identical to today's autocommit read.
const prefs = await tenantTx(this.dataSource, (m) =>
  m.getRepository(UserPreference).findOne({ where: { userId } }),
);

// Read-modify-write / multi-table: one tenantTx replaces the QueryRunner block.
await tenantTx(this.dataSource, async (m) => {
  const repo = m.getRepository(UserPreference);
  const row = await repo.findOne({ where: { userId } });
  // ...mutate + repo.save(row); all queries share the transaction + tenant GUC.
});
```

- Inject `DataSource`, not a repository. Get repositories from the transaction's `EntityManager` (`m.getRepository(X)`); helpers that took a `QueryRunner` take the `EntityManager` instead.
- `tenantTx` **throws** without an ambient identity context. Authenticated controllers already have it (the `RequestContextInterceptor` seeds `{ userId }` around the handler). Code with no HTTP request — cron jobs, seeders, guards/strategies, background writes — must wrap the call in `withUserContext(userId, fn)` or `withSystemContext(fn)` (`backend/src/common/db/with-context.ts`).
- Nested `tenantTx` calls join the ambient transaction (same connection/atomicity), so a service method calling another is safe — no pool-exhaustion deadlock.
- At `RLS_MODE=off` (the default) `tenantTx` still wraps the transaction but skips the identity GUCs, so behavior is identical to pre-RLS. See `docs/future-plans/row-level-security.md`.

## Financial Math

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

## Environment

Key env vars (see `.env.example` for full list):
- `JWT_SECRET` -- minimum 32 chars, enforced at startup
- `AI_ENCRYPTION_KEY` -- minimum 32 chars, for API key encryption
- `DATABASE_*` -- PostgreSQL connection
- `DEMO_MODE=true` -- enables demo restrictions, daily reset at 4 AM UTC
- `LOCAL_AUTH_ENABLED` / `REGISTRATION_ENABLED` -- auth toggles
- `OIDC_*` -- OpenID Connect provider config
