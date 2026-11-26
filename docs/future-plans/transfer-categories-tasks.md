# Transfer Categories: Agent Task List

> Companion to [`transfer-categories.md`](./transfer-categories.md) (the plan). The work is six pull requests into one integration branch, then one into `main`. Each PR is a list of steps; a step is one agent session and one commit. Mark a step done by checking its box and noting the commit.

## How to use this list (read first, every session)

- **Integration branch `transfer-categories/integration`**, cut from `main`. Each PR below is one branch off it; its steps are commits on that branch, done in the order listed. Nothing merges to `main` until PR 7.
- **PR 1 is approved by the maintainer before PR 2 starts.** It may change the defaults in the plan's section 12; later PRs build what it says.
- **A step stays inside its PR's area.** Work outside it is a scope violation: stop and leave a note.
- **Read first:** `AGENTS.md`, the layer `CLAUDE.md`, and the documents its table names for the step's subject. Re-locate code by symbol, never by line.
- **Checks:** the step's own specs plus the guards, under `TZ=UTC`; never a whole suite. Stage new files before a guard runs. The full gate runs once per PR, before it is opened.
- **Strings:** English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is in PR 6, once.
- **"The plan"** means `transfer-categories.md`; section references point there.

## The pull requests

| PR | Contents | Depends on | Behaviour change | Status |
|----|----------|-----------|------------------|--------|
| 1 | Specification | -- | none | [ ] |
| 2 | The category type, end to end | 1 | none while no Transfer category exists | [ ] |
| 3 | Rules for what a row may hold, on every write path | 2 | yes | [ ] |
| 4 | Reports and budgets | 2 | yes | [ ] |
| 5 | Migration of existing data | 3, 4 | yes | [ ] |
| 6 | Docs, end-to-end tests, locales, release notes | 5 | none | [ ] |
| 7 | Integration branch into `main`, by the maintainer | 6 | the release | [ ] |

PRs 3 and 4 touch different modules and can be built side by side. Every other pair is sequential.

---

## PR 1: Specification

One document in `docs/specs/`, no code.

- [ ] Truth tables for FIT and ONE per entry point; migration examples; the budget line migration with numbers (Q3); the three funding figures; the three transfer measures; invariant IDs.
- [ ] Measure the database backstop on a bulk import and record the answer to Q4.

Done when the maintainer has approved it and every default in the plan's section 12 is confirmed or replaced there.

## PR 2: The category type, end to end

Backend and frontend know the third type; nothing can use it on a row yet.

- [ ] Schema: `category_type` column, check, backfill, the `is_income` mirror trigger; both split constraints relaxed; `schema.sql`; entity; support-backup and undo column lists.
- [ ] Category service and API: `type` in and out, derived `isIncome`, inheritance, type-change refusal, type filter, stats; `list_categories` in the assistant and MCP.
- [ ] Backend reader sweep: every `isIncome` read moves to a typed helper; the READ guard.
- [ ] Frontend: types, typed helper and reader sweep; category form, list and detail.
- [ ] Default Transfer set and its translations in the default import.

Done when the existing specs of every touched module pass unchanged and a Transfer category can be created, listed and edited.

## PR 3: What a row may hold

FIT and ONE on every path that writes a category, with the screens that drive them.

- [ ] The fit helper and the entry-point integration matrix, written failing first.
- [ ] Standalone transfers and ordinary rows: create, update, plain patch, conversion both ways, reassign.
- [ ] Both sides together: bulk update, plain patch, the assistant's categorize action; the cross-owner rule.
- [ ] Split transfer lines carry a category: create, add, remove, collapse, linked row, bulk recategorize, undo.
- [ ] Scheduled transfers, scheduled split lines, overrides and posting.
- [ ] Rules: `set_category` on a transfer, skip reasons, `convert_to_transfer` naming a category; the rules editor.
- [ ] Importers: QIF payee default off transfers, Money's transfer category (Q5), split lines.
- [ ] Assistant and MCP write tools: schemas, descriptions, refusals; context and forecast.
- [ ] Frontend: pickers by row kind across transaction, scheduled, bulk, quick-add, payee and import screens; inline create; the split editor's transfer line.

Done when the entry-point matrix is green and each importer's existing fixtures import without a row that does not fit.

## PR 4: Reports and budgets

Every read that shows a Transfer category.

- [ ] Monthly Category Breakdown: Transfers group by Transfer category, then by account; its screen.
- [ ] Register filters, grouped totals, category detail for a Transfer category, MCP flow totals.
- [ ] Custom reports: Transfer categories in filters and groups; Outgoing / Incoming / Net; INV-REPORT-004 amended; builder and viewer.
- [ ] Budget line on a Transfer category; the category line wins over the account line.
- [ ] Actual Income, Transfer Funding, Total Budget Funding on every budget income surface, period close included; wizard, edit page and period detail.

Done when a report or budget with no Transfer category returns the figures it returned before, and the new figures match the specification's numerical examples.

## PR 5: Migration of existing data

- [ ] Migration record tables (policy, backup, delete-my-data) and the per-user migration function: steps 1 to 5 of the plan's section 7.
- [ ] Settings remap: schedules, saved reports, rule conditions and actions, budget lines.
- [ ] Restore of an older backup runs the function; the migration integration suite.
- [ ] The one-time review list of changed reports, rules and budgets (Q7).

Done when the checks at the end of the plan's section 7 pass on real PostgreSQL.

## PR 6: Docs, tests, locales

- [ ] Contract docs: invariant catalog entries, `docs/financial-semantics.md`, the backend and frontend indexes, corrected tool and DTO text.
- [ ] Website docs, retaken screenshots, help links.
- [ ] E2E specs from the plan's section 10.
- [ ] Full-locale i18n pass.
- [ ] Release notes and What's new; a follow-up issue for the `is_income` column drop and the migration re-run.

## PR 7: Into `main`

Opened and merged by the maintainer once PR 6 is in.
