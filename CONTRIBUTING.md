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
- **Follow existing conventions** — project structure, i18n for all locales, and tests for any new behavior (see below).
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

Every user-facing string must be translated — no hardcoded literals in toasts, labels, placeholders, validation messages, or emails. **A feature is not done until it is fully internationalized for every supported locale in the same PR** (`de`, `en`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, plus the `xx` pseudo-locale). Parity tests will fail if a locale is missing a key. After editing any `en/*.json`, regenerate the pseudo-locale with `npm run i18n:pseudo`. See `frontend/src/i18n/messages/README.md` and `backend/src/i18n/README.md` for the full flow.

### Code style

- No emojis in code, comments, or documentation.
- Immutability always — never mutate objects or arrays in place.
- No `console.log` in production code; use the NestJS `Logger`.

### Security (do not regress)

- Parameterized queries only — never interpolate user input into SQL.
- Controllers use `@UseGuards(AuthGuard('jwt'))`; service methods derive `userId` from the JWT, never from request params/body.
- DTOs use `whitelist: true` + `forbidNonWhitelisted: true` with appropriate validation decorators.
- Any operation touching multiple tables or doing read-modify-write must use a `QueryRunner` transaction (see `CLAUDE.md`).
- Money values are `decimal(20,4)`; use integer-cents arithmetic to avoid floating-point drift.

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## Before you open a PR

- [ ] An approved discussion or issue exists, and it is linked in the PR.
- [ ] The PR addresses a single concern.
- [ ] New behavior has tests, and the existing suite passes.
- [ ] All user-facing strings are translated for every locale.
- [ ] The branch is rebased on the latest `main`.
- [ ] AI assistance is disclosed, and you've reviewed and own the result.

## Development setup

Everything runs in Docker:

```bash
docker compose -f docker-compose.dev.yml up
```

Pre-commit hooks (husky + lint-staged) run automatically on commit. See the `CLAUDE.md` files for layer-specific commands and structure.

Thanks for helping make Monize better!
