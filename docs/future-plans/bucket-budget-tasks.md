# Bucket Budget Strategy: Agent Task List

> Companion to [`bucket-budget.md`](./bucket-budget.md) (the design). This file breaks the plan into tasks sized for one AI-agent session each. Do the tasks in dependency order. Mark a task done by checking its box and noting the commit.

## How to use this list (read first, every session)

- **One task per agent session, one commit per task, all on the branch `feat/bucket-budget`** (worktree `/home/ken/monize-bucket-budget`). Tasks that share files run one after another, never in parallel in the one worktree. The branch becomes one PR when Q2 is done.
- **Each task lists its files.** Touching a file outside the list is a scope violation: stop and leave a note instead.
- **The governing invariant applies to every task:** bucket arithmetic is written once, in `computeBudgetBucketFigures` (INV-BUDGET-001). A service that adds bucket figures some other way, or a component that adds, subtracts or divides them, is off the plan.
- **Naming:** every new symbol is `BudgetBucket...` / `budget_bucket...`. A bare "bucket" in `backend/src/budgets` already means a time bucket (`queryCategorySpendingBuckets`).
- **Read first:** `AGENTS.md`, the layer `CLAUDE.md`, and the documents its table names for the task's subject. Re-locate code by symbol, never by line.
- **Running checks:** the host has no usable `node_modules`. Run every npm command in a throwaway `node:24-alpine` container with the worktree mounted at its own path, `/home/ken/monize/.git` mounted at the same path, and the `monize_verify_be_nm` / `monize_verify_fe_nm` volumes as `node_modules`, as uid 1000 (as root with git installed for the tree-walking guards). Run only the specs the task touches plus the guards (`npx jest --testPathPatterns "guard\.spec\.ts$"` for backend source changes); never a whole suite or a coverage run.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit --incremental false && npm run typecheck`, the task's specs, the guards.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, the task's tests.
  - New files staged (`git add -N` is enough) before any guard runs.
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo` in the layer. The full-locale pass is Q2, once, at the end.
  - The agent does not commit; the supervising session reviews the diff, re-runs the checks and commits.
- **Terminology:** "the design" = `bucket-budget.md`; section references point there.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships real code, a table or endpoints that change nothing until a person creates a bucket. |
| **neutral** | Rewrites a live code path. Designed behaviour-preserving for budgets without buckets; the touched module's existing specs are the gate. |

## Task graph

| ID | Task | Depends on | Deploy impact | Recommended agent | Status |
|----|------|-----------|---------------|-------------------|--------|
| B1 | Migration + `schema.sql`, entities, `BUCKET` enum value, RLS, backup and deletion classification | -- | inert | opus, high | [x] |
| B2 | Bucket CRUD and line assignment (INV-BUDGET-002) | B1 | inert | sonnet, high | [x] |
| B3 | `computeBudgetBucketFigures` and `GET .../reports/bucket-status` (INV-BUDGET-001) | B2 | inert | sonnet, high | [x] |
| B4 | Period snapshots and carry-over at close (INV-BUDGET-003) | B3 | neutral | opus, high | [x] |
| B5 | Wizard apply accepts buckets, in one transaction | B2 | neutral | sonnet, medium | [x] |
| B6 | Bucket figures in the assistant and MCP `get_budget_status` | B3 | neutral | sonnet, medium | [x] |
| F1 | Types, API client, the fifth strategy in every list, English copy | B2 | inert | sonnet, medium | [x] |
| F2 | `BudgetBucketEditor`, presets, edit-page section, line form select | F1 | inert | opus, medium | [x] |
| F3 | Dashboard `BudgetBucketSummary` and period-detail bucket rows | F1, B3, B4 | inert | sonnet, medium | [x] |
| F4 | Wizard: bucket setup, per-line picker, review | F2, B5 | neutral | opus, high | [x] |
| D1 | Website docs, docs link, E2E factory type | F3, F4 | none | sonnet, low | [x] |
| Q1 | Integration suite on real PostgreSQL | B4, B5 | none | opus, medium | [x] |
| Q2 | Full-locale i18n pass (final commit) | all above | none | sonnet, medium | [x] |

Backend order: B1, B2, B3, B4, B5, B6. Frontend order: F1, F2, F3, F4. B5 and B6 touch different files from each other and from F1; all other pairs share files and are sequential.

---

## Task details

### B1 -- Tables, entities, classification

Files: a new timestamped migration in `database/migrations/`; `database/schema.sql`; `backend/src/budgets/entities/budget.entity.ts`, `budget-category.entity.ts`, `budget-period.entity.ts`, new `budget-bucket.entity.ts` and `budget-period-bucket.entity.ts`; `backend/src/budgets/budgets.module.ts`; `backend/src/backup/` (`export-table-queries.ts`, `restore-plan.ts`, `restore-references.ts`, `restore-wipe.ts`, `backup-format.ts`, `support-backup/support-backup-rules.ts`, `support-backup/support-backup-integrity.ts`, `support-backup/support-backup-sections.ts`); `backend/src/users/users.service.ts` (`runOwnedDataDeletes`); `backend/test/integration/rls-enforcement.integration.spec.ts` (`INDIRECT_MAP`); `backend/test/helpers/rls-catalog.ts` if a CHECK needs a shaped value; `frontend/src/lib/restore-labels.ts` and the `en` catalog key it reads.

- Design sections 6.1 to 6.3 exactly. Migration: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP ... IF EXISTS` before each trigger, constraint and policy, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for both tables, no role named. Precedents: `20261110212308_payroll_deduction_rule_periods.sql` (child table), `20260918014500_ai_relay_attachments.sql` (indirect policy), `113_rls_policies_indirect.sql` (the budget policies to copy the shape of).
- `schema.sql` in the same change: tables beside the budget block, triggers beside the budget triggers, policies in the "Budgets family" block.
- Entities declare `onDelete` exactly as the SQL does (`schema-entity-parity` compares them) and `@Unique` for both unique keys; decimals `precision: 24, scale: 8`.
- `BudgetStrategy.BUCKET = "BUCKET"`; `Budget.buckets` relation; `BudgetCategory.bucketId` and relation; `BudgetPeriod.periodBuckets` relation.
- Backup: export queries in FK order, `RESTORE_PLAN` entries (`budget_buckets` before `budget_categories`; `budget_period_buckets` after `budget_periods`), reference columns including `budget_categories.bucket_id`, wipe and owned-data deletes in FK order, optional `BackupData` members, support-backup rules (`name: mask`, money `scale`, keys and flags `keep`), `REFS`, `UNIQUE_MASKED_TEXT` for `budget_buckets.name` grouped by `budget_id`, section membership, restore labels.

Acceptance: `npm run migration:lint:test && npm run migration:lint`; `scripts/verify-schema.sh`; unit specs `restore-plan.spec.ts`, `restore-references.spec.ts`, `export-driver-values.spec.ts`, `support-backup-rules.spec.ts`, `entity-decimal-precision.spec.ts`, `entity-varchar-capacity.spec.ts`, `raw-sql-columns.spec.ts`; `restore-labels.contract.test.ts`; integration specs `schema-entity-parity`, `rls-enforcement`, `backup-restore`, `support-backup`, `migration-path` against a throwaway `postgres:16-alpine` (each by file, with `npx jest --config ./test/jest-e2e.json --runInBand`).

### B2 -- CRUD and assignment

Files: new `backend/src/budgets/budget-buckets.service.ts` and spec; new DTOs `create-budget-bucket.dto.ts`, `update-budget-bucket.dto.ts`; `create-budget-category.dto.ts`, `update-budget-category.dto.ts`, `bulk-update-budget-categories.dto.ts`; `budgets.service.ts` (`findOne` loads `buckets`; `addCategory`, `updateCategory`, `bulkUpdateCategories` honour `bucketId`); `budgets.controller.ts` and spec; `budgets.module.ts`; `backend/src/i18n/locales/en/errors.json`.

- Routes and refusals of design 6.4; truth table D. Every refusal's check runs inside the write's `withScopedDb` transaction, before the write.
- `targetValue` and `carryCap` use `@IsMoneyAmount`; `bucketId` is `@IsUUID` with `@ValidateIf` allowing `null`.
- The two `GET` routes carry `@AllowDelegate()`; writes do not.
- No action-history record (decision 13).

Acceptance: `budget-buckets.service.spec.ts` covers every 6.4 refusal and truth table D with typed mocks; `budgets.controller.spec.ts` pins `ParseUUIDPipe` on both ids; `pat-access.routes.guard.spec.ts`, `array-bound-dto.spec.ts`, `money-amount-dto.guard.spec.ts` green.

### B3 -- Figures and live read

Files: new `backend/src/budgets/budget-bucket-figures.util.ts` and spec; new `backend/src/budgets/budget-bucket-reports.service.ts` and spec; `budget-reports.service.ts` (delegating method); `budgets.controller.ts` and spec; `budgets.module.ts`; `docs/system-invariants.md` and `docs/verification-contract.md` (INV-BUDGET-001 and INV-BUDGET-002, new "Budgets" section and matrix rows).

- `computeBudgetBucketFigures(input)` is pure: buckets, the line breakdown rows with each line's `bucketId`, the bucket income inputs (`incomeLinked`, `baseIncome`, income lines' budgeted sum, actual income), `carriedIn` per bucket, the currency's money decimals. It returns the 6.5 shape minus the period fields, plus `carryOut` per bucket. Definitions: design section 4.
- The service reads the line breakdown through `BudgetsService.getSummary` (no actuals query of its own), reads `carry_in` from the reported period's `budget_period_buckets` rows (none before B4: every `carriedIn` is 0), and calls the function.

Acceptance: the util spec asserts truth tables A, B, C and the section 8 examples as literal numbers; `invariant-catalog-parity.spec.ts` and `doc-paths.spec.ts` green.

### B4 -- Snapshots and carry

Files: `backend/src/budgets/budget-period.service.ts` and its specs (`budget-period.service.spec.ts`, `budget-period-lifecycle.spec.ts`); `budget-period-cron.service.ts` only if its call signature must change; `docs/system-invariants.md` and `docs/verification-contract.md` (INV-BUDGET-003).

- `closePeriod`: inside the existing transaction and lock, after the line actuals, build the same inputs as the live read from the close's own actuals and call `computeBudgetBucketFigures`; upsert one `budget_period_buckets` row per current bucket with the frozen columns of 6.3; pass each nonzero `carryOut` to the next period's creation.
- `createPeriodForBudget`: accepts an optional bucket carry map and inserts `carry_in` rows (with `bucket_name`, `target_type`, `target_value` as they are now) only when it won the `ON CONFLICT` claim, exactly as it does for lines.
- The period detail read returns `periodBuckets`.
- A budget with no buckets writes no rows and behaves as before.

Acceptance: specs for truth table C through a mocked close; the carry map reaching the next period; no write for a bucketless budget; existing period specs unchanged and green.

### B5 -- Wizard apply

Files: `backend/src/budgets/dto/apply-generated-budget.dto.ts`; `budget-generator.service.ts` and spec.

- Design 6.6. `buckets` has `@ArrayMaxSize(12)`. The apply becomes one `withScopedDb` callback: ownership checks, budget, buckets, then lines with `bucketKey` resolved to the new ids. An unknown or duplicate key, or a key on an income line, is refused before anything is written.

Acceptance: spec proves one transaction (one `withScopedDb` entry for the writes), key resolution, each refusal with no write; existing apply cases green.

### B6 -- LLM shape

Files: `backend/src/budgets/budget-reports.service.ts` and spec; `backend/src/mcp/tool-output-schemas.ts`; `backend/src/ai/query/` only if its output typing names the shape.

- Design 6.8, read from the B3 service.

Acceptance: `tool-output-schemas.spec.ts`, `tools-list-budget.spec.ts`, `mcp-annotations.spec.ts` green; spec cases for present and absent `buckets`.

### F1 -- Types, client, strategy lists

Files: `frontend/src/types/budget.ts`; `frontend/src/lib/budgets.ts` and test; `frontend/src/components/budgets/utils/budget-labels.ts`; `BudgetForm.tsx`, `BudgetWizardAnalysis.tsx` and their tests; `StrategyDetailCard.test.tsx`; `frontend/src/i18n/messages/en/budgets.json` (then `npm run i18n:pseudo`).

- Design section 10, first two bullets. English copy for the Bucket card: title, description, pros, cons, best-for, in the voice of the four existing cards.

Acceptance: `BudgetWizardAnalysis.test.tsx` expects `strategy-BUCKET`; `BudgetForm.test.tsx` expects the option; `i18n:check` green.

### F2 -- Editor, presets, edit page

Files: new `frontend/src/components/budgets/BudgetBucketEditor.tsx` and test; new `frontend/src/components/budgets/utils/budget-bucket-presets.ts` and test; `BudgetCategoryForm.tsx` and test; the budget edit page (route `/budgets/[id]/edit`) and its test; `en/budgets.json`.

- Design section 10: presets, editor, edit-page section, line form select. Client-side validation mirrors 6.4; the server stays the authority and its refusal message is shown.
- Follow the existing form, modal, money-input and confirm-dialog patterns of the budget edit page; read `frontend/CLAUDE.md` and the `docs/frontend/` rows it names first.

Acceptance: tests for add, edit, remove, each validation, preset application, the select appearing only for a Bucket budget.

### F3 -- Dashboard card and period detail

Files: new `frontend/src/components/budgets/BudgetBucketSummary.tsx` and test; `BudgetDashboard.tsx` and test; `BudgetPeriodDetail.tsx` and test; `en/budgets.json`.

- Design section 10. The card renders server figures only; a null allocation renders the missing-income message with a link to the edit page (design section 9), never 0. Numbers through `useNumberFormat()` and the dashboard's `formatCurrency`.

Acceptance: tests for a full card, null allocation, over-allocation flag, unassigned row, empty state; period detail shows rows for a closed period only.

### F4 -- Wizard

Files: `BudgetWizard.tsx`, `BudgetWizardCategories.tsx`, `BudgetWizardReview.tsx` and their tests; `en/budgets.json`.

- Design section 10, wizard bullet. `WizardState.buckets` holds editor rows with a client `key`; the review builds `buckets` and each line's `bucketKey` for apply. Choosing Bucket on the analysis step pre-applies "Three buckets" and assigns nothing; leaving Bucket clears nothing the person typed.
- The 50/30/20 picker and its allocation bar are untouched.

Acceptance: tests for preset switch, per-row select, payload shape, the unassigned warning on review, and that the other four strategies' payloads are unchanged.

### D1 -- Documentation

Files: `website/docs/budgets.md`; `frontend/src/lib/docs-links.ts` and test; `e2e/helpers/factories.ts` (strategy union).

- "four strategies" becomes five; a Bucket row in the strategies table; a "Buckets" section (targets, carry-over, unassigned, bucket income); the Strategy Widgets list; the wizard and edit-page field tables. Run `npm run docs:build` in `website/` if the build is available in the container. Screenshots are regenerated by the maintainer's screenshot run, not here; say so in the hand-back.

Acceptance: `docs-links.test.ts`, `help.real-docs.spec.ts`, `doc-paths.spec.ts` green.

### Q1 -- Integration suite

Files: new `backend/test/integration/budget-buckets.integration.spec.ts`.

- On real PostgreSQL: truth table D through the service with a second user's bucket (INV-BUDGET-002); two consecutive closes with the section 8 figures, asserting `carry_in` of period two equals `carry_out` of period one, with and without a cap (INV-BUDGET-003); deleting a bucket nulls `bucket_id` on its lines and keeps its closed snapshot rows; apply rolls back whole on a bad `bucketKey`.

Acceptance: the file passes by itself with `npx jest --config ./test/jest-e2e.json --runInBand`.

### Q2 -- Localization pass

Files: every non-English, non-`xx` catalog under `frontend/src/i18n/messages/` and `backend/src/i18n/locales/` that lacks a key the branch added.

- Translate every new key; regional variants (`en-GB`, `en-US`) get an override only where the wording differs. Never hand-edit `xx`.

Acceptance: `messages.parity.test.ts`, `messages.duplicate-keys.test.ts`, `messages.punctuation.test.ts`, backend `locales.parity.spec.ts`, `npm run i18n:check` in both layers.
