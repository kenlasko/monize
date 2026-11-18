# KMyMoney (.kmy) import: plan

> Companion to [`kmymoney-import-tasks.md`](./kmymoney-import-tasks.md) (the work packages). The design
> and every mapping rule, truth table, warning code and API shape are in
> `docs/specs/kmymoney-import.md` ("the spec"); the file format is `docs/kmymoney-data-model.md` ("the
> reference"). Read the spec's sections 4, 5 and 8 before any work package; read the reference section
> a rule cites before implementing that rule. Re-locate existing code by symbol, never by line.

## Goal

A KMyMoney user uploads their `.kmy` (or plain `.xml`) file to the Import wizard and gets their whole
profile in Monize, through the same review, background import and verification report the Microsoft
Money import uses. GPG-encrypted files, SQL databases, anonymized files and the 0.8 binary format are
refused, each with a message saying what to do instead.

## Assumptions (restated so a fresh session can execute this)

- Branch `feat/kmymoney-import`, off `main`. Dependencies installed (`npm ci` in `backend/`,
  `frontend/`, `e2e/` when a fresh worktree lacks them).
- The Money importer is shipped and is the model: `backend/src/import/mny/` (reader, mappers, writers,
  services, controller), the wizard path in `frontend/src/hooks/useImportWizard.ts`,
  `frontend/src/hooks/useMnyImport.ts`, `frontend/src/components/import/Mny*.tsx`,
  `frontend/src/app/import/page.tsx`, and `e2e/tests/import-mny.spec.ts`.
- Its intermediate model (`backend/src/import/mny/model/mny-import-model.ts`) and container
  (`MnyParsedFile` in `backend/src/import/mny/mny-parser.service.ts`) are what the KMyMoney mappers
  produce. Everything after the parser is shared and must keep its Money behaviour exactly.
- XML is tokenized with `htmlparser2` (already a direct backend dependency, spec 14.1). **No dependency
  is added and no `package.json` or `package-lock.json` changes.** If any work package finds it needs
  one, it stops and reports (adding a dependency is an "ask first" item in `AGENTS.md`).
- No database migration: `source_format` and the price/rate `source` columns are free text (spec K3),
  and the payee aliases, default categories and contact details of WP3c go to `payee_aliases` and
  `payees` columns that already exist.
- No new environment variable: the inflated XML is bounded by `MNY_IMPORT_LIMIT_MB` (spec 4.2).
- The 46 upstream KMyMoney sample files are not committed (unclear licence; two contain personal-looking
  data). Committed fixtures are synthetic: the reference's section 18 file (written for that document,
  free to use) as plain XML and gzipped, plus TypeScript builders. The upstream files may be fetched
  into a scratch directory outside the repository for the corpus run in WP3b; nothing under that
  directory is committed.
- The maintainer's standing rule while developing: run only the specs of the files you changed (plus the
  guard specs a work package names), never a full suite or a `test:changed` sweep. CI owns the coverage
  gates (backend 95/94/95/85, frontend 91/90/87/85), so every new module ships with a spec that covers
  it.
- i18n: English first and `npm run i18n:pseudo`; every other locale is translated in WP7, the last
  commit before review. Between the first English key and WP7 the two parity specs
  (`frontend/src/i18n/messages.parity.test.ts`, `backend/src/i18n/locales.parity.spec.ts`) are
  expected to fail; nothing else may be red. Never hand-edit `xx/*`; never rename an existing key.
- Commits: Conventional Commits, one logical change each, no emojis, ending with the `Co-Authored-By`
  trailer the session's attribution instructions give (the orchestrator's brief names
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`). Do not push; do not open a PR.
- A guard that fires is met by fixing the code. Allowlist and baseline entries this plan adds are
  reviewed decisions and are listed in the final report (section "Reviewed decisions" below); no other
  entry is added.

## Evidence

- The reference was derived from KMyMoney's reader and writer source at commit
  `d3943e0de789efede86b56c4246e7f4338fcc664` and libalkimia; every rule the spec relies on cites it.
- All 46 upstream samples tokenize with `htmlparser2` in XML mode with no nesting error (probed while
  writing the spec). They cover every account type except 6, 8, 11 and 14, every investment action
  except `Split`, two schedules (monthly), a loan with auto-calc schedule splits, multi-currency
  transfers, BTC (`saf` 100000000) and fix versions 1 to 12. **No sample contains a stock split or a
  matched transaction** (reference 17.2), so both are covered by builder fixtures only.
- Throughput: a 59 MB synthetic document (120,000 two-split transactions) tokenizes in 1.6 s.
- The shared writer `writeCategories` builds trees of any depth when `parentName` is the parent's
  `fullName` (it looks the parent up by `idByFullName.get(parentName)`), so KMyMoney's category tree
  imports at full depth with no writer change (spec 5.4).
- The holdings fold (`HoldingsService.computeHoldingsMap`) already carries cost basis from a
  TRANSFER_OUT to its linked TRANSFER_IN, so a KMyMoney security move keeps its basis once the two rows
  are paired (spec 5.7.4).

## What already works and is reused as it is

Staging (`MnyStagingService`, which already takes `sourceFormat`), the job lifecycle and fencing
(`MnyImportJobService`), the one-active-import index shared across formats (INV-IMPORT-001), the
committed-content duplicate refusal, the optional start-fresh wipe, `writeAll` and every writer, the
transaction-rules pass, `ImportPostProcessingService`, `computeExpectedBalances`,
`investmentWritesOwnCashRow`, `mapLoans`, `selectedBills`, `pairShareTransfers` (after it is exported),
`summarizeWarnings`, the preview builder, the job/result DTOs, `StartMnyImportDto` and
`MnyImportOptionsDto` (no new request field), and every wizard component.

## What changes in shared code

Spec section 4.9 is the authoritative list, file by file. Every change is an optional field or a
defaulted parameter, so the Money path is behaviour-identical; the work package that makes a change runs
that file's existing Money spec unchanged and adds one case for the new behaviour.

## Design in one page

1. **Reader** (WP1): sniff the container (spec 4.3), inflate gzip with `maxOutputLength`, apply
   KMyMoney's byte filter (spec 4.4), tokenize by element path, build the raw model with exact BigInt
   rationals and ordinal handles (spec 4.5, 4.6). Pure, synchronous, no database.
2. **Mappers** (WP2): raw model to `MnyParsedFile`: accounts and investment pairs, opening balances,
   categories, payees, tags, transactions and transfers, investments, securities, prices and rates,
   schedules, loan terms through `mapLoans`, warnings, and the file-computed expectations of spec
   section 6. Pure, synchronous, no database.
3. **Shared generalisation** (WP3a): the spec 4.9 changes, so the job, writers and report can carry a
   KMyMoney import.
4. **Wiring** (WP3b): `KmyParserService` (reads the user's default currency and the CRYPTO codes, then
   calls the two pure functions), `KmyImportController` at `import/kmy`, module registration, guard
   entries, the backend messages, the real-PostgreSQL integration spec, and the corpus run.
5. **Frontend** (WP4): a format descriptor, the KMyMoney API client, the parameterised components and
   hook, routing, the large-upload proxy route, English copy.
6. **Payee matching, default categories and contact details** (WP3c, spec 5.5 and K13): KMyMoney's
   matching rules become payee aliases where the translation is exactly equivalent (a regex subset the
   spec names) and are otherwise skipped with a warning naming the payee and the key; collisions follow
   Monize's own alias-overlap refusal; default categories and contact details fill only what is empty.
   One shared writer, inside the import's transaction, after the transaction-rules pass, so the
   import's own rows keep KMyMoney's payees. **No migration**: every column and the unique index exist.
7. **Docs** (WP5) and **e2e** (WP6), then **translations** (WP7) and **screenshots** (WP8, deferrable).

## Work packages and parallelism

| Phase | Work packages (run in parallel within a phase) | Needs |
|---|---|---|
| 0 | WP0 contract: shared types, raw-model types, rationals, error classes, ignore rules | the spec |
| 1 | WP1 reader, WP2 mappers, WP3a shared generalisation, WP5 docs | WP0 merged |
| 2 | WP3b backend wiring and integration, WP4 frontend | WP1, WP2, WP3a (for WP3b); WP0, WP5 (for WP4) |
| 3 | WP3c payee matching, default categories and contact details; WP6 e2e | WP1, WP2, WP3a, WP3b, WP4, WP5 (for WP3c); WP3b, WP4 (for WP6) |
| 4 | WP7 translations | everything with user copy, WP3c included |
| 5 | WP8 screenshots (may be deferred to a follow-up PR) | WP6, WP3c, a running stack |

File ownership is disjoint within each phase (the task list names every file). Two packages that must
touch the same file are in different phases. WP3c was added after WP0 was committed (the maintainer
asked for payee matching to be imported, not skipped); it touches files that WP0, WP1, WP2, WP3a, WP3b,
WP4 and WP5 own in earlier phases, which is why it runs in phase 3, after all of them, beside WP6
(e2e files only).

## Ground truth

Expected numbers come from the reference's section 18 file, checked by script against KMyMoney's balance
rules when the reference was written, never from the importer's output:

| Monize account | Expected |
|---|---|
| Checking (CHEQUING, USD) | opening 5,000.00; final 2,804.50 |
| EUR Savings (SAVINGS, EUR) | 1,000.00 |
| Old Savings (SAVINGS, USD, closed 2024-01-10) | opening 100.00; final 0.00 |
| Brokerage Account - Cash (INVESTMENT_CASH, USD) | 647.50 |
| Brokerage Account - Brokerage (INVESTMENT_BROKERAGE) | 0.00; holds 15 EXC, total cost 378.75 |
| Categories | Utilities > Electricity, Groceries, Bank Fees, Dividends (income) |
| Payees / tags | Corner Market, City Power / household |
| Payee aliases (after WP3c) | City Power: `*CITY POWER*`, default category Electricity; Corner Market: none (matching disabled, `payeeMatchingDisabled`) |
| Scheduled transactions | 1: Electricity, MONTHLY, next 2024-03-01, -75.00 from Checking |
| Prices | EXC 2024-02-10 50, 2024-05-01 30; rate EUR to USD 2024-01-15 1.1 |
| Transfers linked | 3 (T4, T5, T7) |
| Investment rows | BUY, DIVIDEND, SPLIT, SELL |

## Reviewed decisions (allowlist and guard entries this plan adds)

The final report to the maintainer lists each of these with the file that holds it:

1. `PAT_CONTROLLERS` in `backend/src/auth/guards/pat-access.routes.guard.spec.ts`: `KmyImportController`
   (class `@AllowPat()`, `start` `@NoPat()`, mirroring `MnyImportController`), plus a
   `PAT_READ_OVERRIDES` entry only if the Money controller has one for its poll.
2. `LARGE_UPLOAD_ROUTES` in `frontend/src/lib/proxy-body-limit.ts` and the two matcher alternations in
   `frontend/src/proxy.ts`: `/api/v1/import/kmy/parse`.
3. `.gitignore`, `.dockerignore`, `backend/.dockerignore`, `frontend/.dockerignore`: `*.kmy` ignored,
   with the fixture exception `backend/src/import/kmy/__fixtures__/sample-*.kmy` in `.gitignore`.
4. The `kmy_import` price/rate source literal (`write-prices.ts`) and its frontend label.

WP3c adds no entry: its writer inserts no transaction (the rule-application-sites guard lists
transaction insert sites only), uses the import's existing `withScopedDb` transaction, and reuses
`insertPayeeAliasIgnoringDuplicate`; it needs no DTO array and no migration.

Expected **not** to need an entry (stop and report if one does): `WITH_CONTEXT_ALLOWLIST`
(`backend/eslint.config.mjs`; the KMyMoney code uses `withScopedDb` only), the derived-state writer guard
(no new balance writer), the rule-application-sites guard (no new transaction writer), the rate
orientation guard (the shared rate writer is reused), the array-bound DTO list (no new DTO array), the
frontend intl-harness and linkified-description lists (no new component or test file outside the
harness), and the Bearer baseline in `.github/workflows/ci.yml` (if Bearer flags a new code comparison,
report it; `.github/` is ask-first).

## Out of scope

Everything in the spec's non-goals; the per-investment-account cash-account dropdown (spec 14.4); loan
interest-rate import (spec 13.1); renaming any `mny` identifier, table, route or i18n namespace;
translating KMyMoney matching keys outside the spec 5.5.1 subset, and changing how Monize itself
resolves aliases (first match, overlap refusal) or the case-sensitivity of its exact-name tier.
