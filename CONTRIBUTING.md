# Contributing to Monize

Thanks for your interest in improving Monize! This project is built almost entirely with AI assistance, and contributions are welcome. To keep the codebase reviewable and the maintainer's workload sane, we follow a **propose-first** workflow. Please read this document before opening a pull request.

## Why a propose-first workflow?

Monize has run into a recurring set of problems with unsolicited, AI-generated contributions:

- Large multi-concern PRs are difficult and risky to review.
- AI-generated code varies in quality and often ignores project conventions.
- Lack of coordination causes overlapping work and merge conflicts.
- The maintainer bears the costs of triage, conflict resolution, and QA.

The steps below exist to head off those problems before any code is written.

## The workflow

1. **Propose first.** Open a [Discussion](https://github.com/kenlasko/monize/discussions) describing the idea before writing code. Explain the problem, the proposed change, and roughly which modules it touches.
2. **Agree on the approach.** The maintainer signs off on scope, boundaries, affected modules, expected size, conventions, and testing strategy.
3. **Get ownership assigned.** The maintainer designates who builds it and when, so two people don't work the same shared area simultaneously.
4. **Then implement.** Open a PR scoped *exactly* to what was agreed, and link the approving discussion in the PR description.

Please don't open a large or shared-area PR cold. Unsolicited large PRs may be asked to go back through the propose-first process before review.

## Pull request rules

- **One concern per PR.** Split large work into a reviewable series of smaller PRs rather than a single sweeping change.
- **Link the approving discussion or issue** in every PR description.
- **Follow existing conventions** — project structure, internationalization (English-first; see below), and tests for any new behavior.
- **Disclose AI assistance and own the result.** Using AI to write code is fine and expected. The author is responsible for the correctness, conventions, and tests of what they submit — "the AI wrote it" is not an excuse for an unreviewed or untested change.
- **Avoid refactoring shared or core areas** without prior agreement. Touching cross-cutting code (auth, transactions, balance math, shared services) requires explicit sign-off in the discussion.
- **Rebase on the latest `main`** before requesting review.

## Project conventions

These are enforced in review and, where possible, in CI. Detailed, layer-specific guidance lives in `CLAUDE.md`, `backend/CLAUDE.md`, `frontend/CLAUDE.md`, and `database/CLAUDE.md`.

### Code organization

- Prefer many small files over few large ones (200-400 lines typical, 800 max). Organize by feature/domain, not by type.
- Always update `database/schema.sql` alongside any migration.
- Always add tests for new functionality.

### Internationalization (i18n)

Every user-facing string must be internationalized — no hardcoded literals in toasts, labels, placeholders, validation messages, or emails. The workflow is **English-first during development; all locales completed once the change is functionally accepted, before merge.**

- **During development and review:** add and edit only the English catalogs (`en/*`), and regenerate the pseudo-locale with `npm run i18n:pseudo`. The pseudo-locale exercises every key, so missing-string bugs still surface in QA. Do **not** hand-translate the other locales while the copy is still in flux.
- **After functional acceptance** (code approved, copy settled): run a single localization pass that fills every supported locale (`de`, `en`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, plus the `xx` pseudo-locale) as the final commit on the same PR.
- **Merge gate unchanged:** `main` still requires full parity, so released code is never partially translated. Parity tests (`messages.parity.test.ts`, `locales.parity.spec.ts`) will fail on a work-in-progress branch until the localization pass runs — that is expected and is not a reason to translate early.

See `frontend/src/i18n/messages/README.md` and `backend/src/i18n/README.md` for the full flow.

### Code style

- No emojis in code, comments, or documentation.
- Immutability always — never mutate objects or arrays in place.
- No `console.log` in production code; use the NestJS `Logger`.

### Security (do not regress)

- Parameterized queries only — never interpolate user input into SQL.
- Controllers use `@UseGuards(AuthGuard('jwt'))`; service methods derive `userId` from the JWT, never from request params/body.
- DTOs use `whitelist: true` + `forbidNonWhitelisted: true` with appropriate validation decorators.
- All database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`) -- the single RLS-compliant door to the database. Any operation touching multiple tables or doing read-modify-write runs inside one `withScopedDb` transaction. Never inject a repository with `@InjectRepository`, call `createQueryRunner()`, call `dataSource.transaction()`, or use a bare `dataSource.query(...)` -- ESLint rejects the first three (see `CLAUDE.md`). `dataSource.transaction()` looks equivalent and is not: it opens a transaction outside the active scoped manager, so it has no identity GUCs and commits independently of the caller's rollback.
- Money values are `decimal(20,4)`; use integer-cents arithmetic to avoid floating-point drift. Financial calculations follow `docs/financial-calculation-contract.md` and `docs/time-series-contract.md` -- in particular, a `total`/`gain`/`tax` field may only carry a value when every component is known; a sum over the non-null subset is a subtotal, not a total.

### Cross-layer contracts

Some rules cannot be satisfied by one file behaving correctly. Those live in `docs/`, indexed by [`docs/system-invariants.md`](docs/system-invariants.md), which lists each invariant with a stable ID, the mechanism enforcing it, and whether the system currently upholds it. Before changing anything that moves money, writes a file, sends an email, runs on a schedule, or touches authorization, find the relevant invariant and name its ID in your PR.

- [`docs/concurrency-and-idempotency.md`](docs/concurrency-and-idempotency.md) -- a transaction is not a concurrency protocol. Which mechanism to use, and what retry means before commit, after commit, and when the result is unknown.
- [`docs/financial-semantics.md`](docs/financial-semantics.md) -- signs, transfer legs, FX rate direction, per-field precision, split and commission arithmetic.
- [`docs/external-side-effects.md`](docs/external-side-effects.md) -- anything PostgreSQL cannot roll back.
- [`docs/verification-contract.md`](docs/verification-contract.md) -- which kind of test your invariant actually requires, and why a mock is often only supporting evidence.
- [`docs/adr/`](docs/adr/) -- why a decision was made. Add one when your change constrains code that does not exist yet.

`CLAUDE.md` states the wording rule these documents share: a guarantee must name the mechanism that makes it true. It is worth knowing before you write a comment, because several comments here have claimed a lock, an atomic increment and a joint commit that the code beside them did not implement.

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## Before you open a PR

- [ ] An approved discussion or issue exists, and it is linked in the PR.
- [ ] The PR addresses a single concern.
- [ ] New behavior has tests, and the existing suite passes.
- [ ] User-facing strings are internationalized — English catalogs complete and the pseudo-locale regenerated (full locale translation lands once the change is accepted, before merge).
- [ ] The branch is rebased on the latest `main`.
- [ ] AI assistance is disclosed, and you've reviewed and own the result.

## Development setup

Everything runs in Docker:

```bash
docker compose -f docker-compose.dev.yml up
```

Pre-commit hooks (husky + lint-staged) run automatically on commit. See the `CLAUDE.md` files for layer-specific commands and structure.

Thanks for helping make Monize better!
