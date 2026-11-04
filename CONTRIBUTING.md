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
4. **Then implement.** Open a PR scoped *exactly* to what was agreed, and link the approving discussion in the PR description. The maintainer marks the approving discussion or issue with the `approved-to-build` label; `.github/workflows/pr-checklist.yml` fails a PR to `main` whose linked items carry no such label or whose template checklist has an unticked box (PRs by maintainers and direct pushes to `main` pass automatically).

Please don't open a large or shared-area PR cold. Unsolicited large PRs may be asked to go back through the propose-first process before review.

## Pull request rules

- **One concern per PR.** Split large work into a reviewable series of smaller PRs rather than a single sweeping change.
- **Link the approving discussion or issue** in every PR description.
- **Follow existing conventions** — project structure, internationalization (English-first; see below), and tests for any new behavior.
- **Disclose AI assistance and own the result.** Using AI to write code is fine and expected. The author is responsible for the correctness, conventions, and tests of what they submit — "the AI wrote it" is not an excuse for an unreviewed or untested change.
- **Avoid refactoring shared or core areas** without prior agreement. Touching cross-cutting code (auth, transactions, balance math, shared services) requires explicit sign-off in the discussion.
- **Rebase on the latest `main`** before requesting review.
- **Commit messages** are imperative, with no trailing period, and use a Conventional Commits prefix with a scope where one fits (`fix(transactions): ...`, `feat(push): ...`, `docs(backend): ...`). AI-assisted commits carry a `Co-Authored-By:` trailer.

## Project conventions

The conventions are written once. `AGENTS.md` is the canonical instruction file for any coding agent (repo-wide rules, commands, the pre-push gate, the workflow, the no-go areas); `CLAUDE.md` imports it and adds only Claude Code specifics; `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `database/CLAUDE.md` and `e2e/CLAUDE.md` the per-layer ones, written out under `docs/backend/` and `docs/frontend/`. [`docs/agent-instructions.md`](docs/agent-instructions.md) explains how those files are tiered and guarded. Cross-layer invariants are indexed by [`docs/system-invariants.md`](docs/system-invariants.md): before changing anything that moves money, writes a file, sends an email, runs on a schedule or touches authorization, find the relevant invariant and name its ID in your PR.

Two of them are worth restating because they shape every PR:

- **Internationalization is English-first.** During development and review, add and edit only the English catalogs (`en/*`) and regenerate the pseudo-locale with `npm run i18n:pseudo`; do not hand-translate the other locales while the copy is in flux. After functional acceptance, one localization pass fills every supported locale (the lists are `frontend/src/i18n/config.ts` and `backend/src/i18n/config.ts`) as the final commit on the same PR. `main` still requires full parity, so the parity tests fail on a work-in-progress branch until that pass runs; that is expected and not a reason to translate early. Full flow: `frontend/src/i18n/messages/README.md`, `backend/src/i18n/README.md`.
- **One database door.** All database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`), and any operation touching more than one table or doing read-modify-write runs inside one such transaction. Never inject a repository with `@InjectRepository`, call `createQueryRunner()`, call `dataSource.transaction()` or use a bare `dataSource.query(...)`; ESLint rejects the first three, and `AGENTS.md` explains why `dataSource.transaction()` is not the equivalent it looks like.
- **A guarantee names its mechanism.** Any use of "atomic", "exactly once", "cannot" or "always" in a comment or a document must name the transaction, index, conditional `UPDATE` or checksum that makes it true; several comments here have claimed a lock, an atomic increment and a joint commit that the code beside them did not implement.

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
