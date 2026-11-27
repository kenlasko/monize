# Backend documentation

`backend/CLAUDE.md` is deliberately short: commands, module layout, the handful of rules that apply to every change, and a table sending the reader here. These documents hold the rules themselves, with the reasoning and the defect each one came from. Read the one whose subject the work touches; nobody needs all of them for one change.

| Document | Read it before |
|---|---|
| `testing.md` | writing or changing a spec, a test helper or a Jest config |
| `modules-and-runtime.md` | adding a module edge, a global provider, an environment variable, a log line or a boot-time hook |
| `entities-and-dtos.md` | adding a column, a DTO field, a raw query or a validator |
| `database-access-and-tenancy.md` | writing a query that decides ownership, authorization, identity or which row counts |
| `transactions-and-money.md` | touching a transaction write, an export, a loan or category derivation (a category's type included), or the Money import |
| `securities-and-providers.md` | touching prices, `src/securities/`, or any `fetch` to a third party |
| `bond-adapters.md` | adding a country's bonds, a new bond product or an engine primitive in `src/bonds/` |
| `ai-and-payees.md` | touching `src/ai/`, `src/payees/lookup/`, a tool description or a search filter |
| `notifications-and-push.md` | producing a notification, touching `src/push/` or `src/notification-center/`, or composing an email or push body |
| `backup.md` | changing anything under `src/backup/` |
| `cron-and-background-work.md` | adding a `@Cron`, a reaper or a long-running job |
| `mcp.md` | adding or changing an MCP tool, resource or prompt, or touching the MCP transport |
| `docs/specs/warranty-tracker.md` section 5 | touching `src/warranties/`: a warranty never writes a ledger row, a balance or a holding (WTY-001, `warranties.guard.spec.ts`), and its status comes from `warrantyStatus` alone (WTY-002) |
| `docs/specs/warranty-tracker.md` decision 9 | letting a delegate read a warranty, its documents or its claims: the sixth `DelegateSection` is `warranties` (`@DelegateRequiresSection("warranties")`, read routes only), and a row's linked purchase is resolved through `delegateReadableAccountScope` so a delegate never learns a transaction outside their accounts (WTY-007) |
| `docs/specs/payroll-deductions.md` sections 3 and 4 | touching `src/payroll-deductions/` or the posting cap in `ScheduledTransactionsService.post`: a rule never writes the ledger (INV-PAYROLL-001, `payroll-deductions.guard.spec.ts`), the cap is read under the posting lock (INV-PAYROLL-002), and `payroll-deduction-cap.ts` is the one definition of paid, remaining and capped (INV-PAYROLL-003) |
| `docs/external-side-effects.md` section 2 | touching `src/attachments/`: an attachment's parent is a transaction or a warranty (`AttachmentParent`), its owner is `user_id`, and its bytes outlive a rollback |

The cross-layer contracts these documents build on stay where they are: `docs/system-invariants.md` (the index), `docs/concurrency-and-idempotency.md`, `docs/financial-semantics.md`, `docs/external-side-effects.md`, `docs/cron-jobs.md`, `docs/verification-contract.md`, `docs/backup-restore-contract.md` and `docs/row-level-security-contract.md`. The database door itself -- `withScopedDb`, the identity contexts, the lint bans -- is in `AGENTS.md`.

Two conventions these documents share:

- **Path conventions.** Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved.
- **A rule that names a guard spec is enforced by that spec.** The prose explains the rule; the spec's failure message points at the offending line. Fix the code, never the grandfather list -- a grandfather list in these guards may only shrink.

When a human points out a defect in code an AI wrote, `AGENTS.md` says what to do: find the existing helper, add a regression test that fails on the original mistake, and write the rule down. The rule goes in the document above whose subject it belongs to, and `backend/CLAUDE.md` gets at most one line naming the thing to use.
