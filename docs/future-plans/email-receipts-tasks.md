# Email receipts: agent task list

> Companion to [`email-receipts.md`](./email-receipts.md) (the design) and
> `docs/specs/email-receipt-matching.md` (the arithmetic).
> Do the tasks in dependency order and mark each one done.

## How to use this list (read first, every session)

- **Upstream gate.** Discussion kenlasko/monize#930 has no `approved-to-build`
  label. This list was executed on a fork branch at the branch author's
  request; a PR to `main` waits for the maintainer.
- **The governing invariants apply to every task:** the mailbox is read, never
  written (INV-RECEIPT-001), and a receipt reaches the ledger only through the
  review card and `/ai/actions/confirm` (INV-RECEIPT-003). A task that writes a
  transaction any other way is wrong: stop.
- **Definition of done for every task:**
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`,
    `TZ=UTC npm run test:unit -- --coverage`; plus `npm run build && npm run
    test:integration` when a query, an entity, a migration or an RLS context
    changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`,
    `npm run test:cov`, `npm run build`.
  - Migrations: `npm run migration:lint`, `scripts/verify-schema.sh`,
    `node scripts/check-migration-prefixes.mjs`.
  - Stage new files before running a guard (`git add -N`).

## Task graph

| ID | Task | Depends on | Status |
|----|------|-----------|--------|
| P1 | Design, spec and this list | -- | [x] |
| D1 | Migrations + `schema.sql`: the three tables, RLS, the widened `ai_review_requests` | P1 | [x] |
| B1 | Parser: definition types, validator, amount grammar, `parseReceipt` (pure) | P1 | [x] |
| B2 | Matcher and proposal builder (pure) | B1 | [x] |
| B3 | Dependencies `imapflow` and `mailparser`; `ImapMailboxClient`; `mail-text.util.ts`; host policy | D1 | [x] |
| B4 | Mailbox settings: entity, DTO, service, controller (view, upsert, delete, test, poll now) | B3 | [x] |
| B5 | Queue: `email_receipt` kind, `enqueueClaimed`, `claimById`, claim payload with the email | D1 | [x] |
| B6 | Pipeline, poll cron with lease, rematch, receipts service and controller | B2, B4, B5 | [x] |
| B7 | Parsers CRUD, approve, test; AI draft and AI proposal; auto-apply | B6 | [x] |
| B9 | OAuth2 (XOAUTH2) for Google and Microsoft 365: migration, start and complete endpoints, token refresh at connect | B7 | [x] |
| B8 | Docs: invariants, cron table, env vars, backup classification, layer docs | B7 | [x] |
| F1 | API clients and types | B7 | [x] |
| F2 | Settings page: mailbox form, OAuth connect buttons and callback page, parsers editor | F1, B9 | [x] |
| F3 | Receipts page, nav entry, inbox row for the new kind | F1 | [x] |
| Q1 | Translate every locale (backend and frontend) | F3 | [x] |
| E1 | E2E against a test IMAP server | F3 | [ ] needs a GreenMail container in `docker-compose.e2e.yml` (a `docker-compose*` change, not done) |

## Tasks

### D1. Tables and RLS

Files: `database/migrations/*_add_email_receipts.sql`,
`database/migrations/*_widen_ai_review_requests_for_email_receipts.sql`,
`database/schema.sql`, the entities, `backend/src/backup/export-table-queries.ts`,
`backend/src/backup/support-backup/support-backup-rules.ts`.

- Acceptance: `migration:lint` clean; the RLS integration spec places each new
  table in the Direct bucket; the backup coverage guard passes.

### B1 to B2. Parser, matcher, proposal

Files: `backend/src/email-receipts/parsing/`, `matching/`, `proposal/`.

- Acceptance: every table row in the spec has a named test.

### B3 to B4. Mailbox

Files: `backend/src/email-receipts/imap/`, `mailbox/`, `backend/package.json`.

- Acceptance: the read-only options test and the write-call source scan; a
  private host refused for a non-admin on save and at connect; the password
  never in a response or a log line.

### B5 to B7. Queue, pipeline, AI

Files: `backend/src/ai-review/`, `backend/src/email-receipts/`,
`backend/eslint.config.mjs` (`WITH_CONTEXT_ALLOWLIST`: the poll cron),
`docs/cron-jobs.md`.

- Acceptance: the cron row passes `cron-doc.spec.ts`; the lease is held around
  the whole poll; AI mode `off` never calls `AiService`.

### F1 to F3. Frontend

Files: `frontend/src/lib/email-receipts-api.ts`, `frontend/src/types/email-receipts.ts`,
`frontend/src/app/settings/email-receipts/`, `frontend/src/app/email-receipts/`,
`frontend/src/components/email-receipts/`, `frontend/src/lib/nav-links.ts`,
`frontend/src/components/ai-review/AiReviewRow.tsx`.
