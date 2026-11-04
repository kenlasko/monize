# How the repository instructs an AI agent

Monize is built almost entirely with AI assistance, so the files an agent reads before and during a task are part of the codebase's design. This document describes that design: which files an agent reads when, what each one is allowed to hold, the guards that keep the always-on files small, and how to add a rule without growing them. `AGENTS.md` states the rules; this document explains the shape they live in.

## The problem this shape solves

An instruction file is read on every task, so every byte in it is paid for on every task, including the ones it does not concern. The first version of this repository kept every rule in `frontend/CLAUDE.md` and `backend/CLAUDE.md`. Each rule arrived with the defect it came from, the reasoning and the guard that holds it, and `frontend/CLAUDE.md` reached 188 KB. A file that size is skimmed, not read, and a rule in it holds no better than no rule.

The fix was to split what every task needs from what one subject needs, hold the always-on files under a byte ceiling the test suite checks, and send the reader to the subject document only when the work touches that subject.

## The tiers

| Tier | Files | When it is read | What it may hold |
|---|---|---|---|
| Always on, repo-wide | `AGENTS.md`, `CLAUDE.md` | Every task, by every agent | Commands, the pre-push gate, the rules nearly every change meets, the workflow, the no-go list, and the table that sends the reader to tier 3 |
| Always on, per layer | `backend/CLAUDE.md`, `frontend/CLAUDE.md`, `database/CLAUDE.md`, `e2e/CLAUDE.md`, `backend/src/mcp/CLAUDE.md` | Every task that touches the layer | Layer commands, layout, a "Need / Use / Never" table naming the helper to use, and a "Read when the work touches it" table over tier 3 |
| On demand, by subject | `docs/backend/*.md`, `docs/frontend/*.md`, the contract documents `docs/*.md`, `docs/specs/*.md` | Only when the task touches the subject | The rule in full: the reasoning, the defect it came from, the guard that enforces it, edge cases, worked examples |
| Records | `docs/system-invariants.md`, `docs/adr/`, `docs/future-plans/`, `docs/release-notes/`, `docs/audits/` | When the task names an invariant ID, revisits a decision, or executes a plan | Invariants with enforcement status, why a decision was made and what was rejected, multi-PR plans, shipped history |
| Session memory | `.trail/learnings/` | Surfaced by the `trail` hook when a learning bears on the task | What a past session decided, tried and ruled out, with the why; never a rule |

The tiers are read top-down and stop as early as the task allows. A one-file backend fix reads `AGENTS.md`, `CLAUDE.md`, `backend/CLAUDE.md` and, from the "Read when" table, one document under `docs/backend/`. A change to a balance reads the three financial contracts the "Before you act, read" table in `AGENTS.md` names, and the invariant entries it will cite in the PR, found by grepping `docs/system-invariants.md` for the ID, never by reading the catalog through.

### Sizes, as of this writing

| File | Bytes | Ceiling |
|---|---|---|
| `AGENTS.md` | ~26 K | 26 KiB |
| `CLAUDE.md` | ~1.5 K | 16 KiB |
| `backend/CLAUDE.md` | ~16 K | 16 KiB |
| `frontend/CLAUDE.md` | ~15 K | 16 KiB |
| `database/CLAUDE.md`, `e2e/CLAUDE.md`, `backend/src/mcp/CLAUDE.md` | 1 K to 7 K | 16 KiB |
| `docs/backend/` and `docs/frontend/` together | ~650 K | none; read by subject |
| `docs/system-invariants.md` | ~600 K | none; read by ID |

A task that touches both layers carries about 59 KB of always-on instruction, roughly 15 thousand tokens, before it reads a line of code. That is the budget the ceilings defend.

## What each always-on file is for

**`AGENTS.md`** is the canonical, tool-agnostic entry point. Every coding agent reads it: Claude Code through the `@AGENTS.md` import in `CLAUDE.md`, Codex and others directly. It holds the commands, the gate that mirrors CI, the conventions the code cannot show (the schema-with-migration rule, the one database door, the transaction rule, the financial-math sentences), the workflow, what an agent may do unasked, and two tables: the contract documents and "Before you act, read". Its ceiling is lower than the others' total because Codex concatenates every `AGENTS.md` it finds under one 32 KiB cap and truncates past it.

**`CLAUDE.md`** imports `AGENTS.md` and adds only what Claude Code specifically should do: navigate with LSP, run the pre-approved checks itself, when a subagent pays for itself, how to report. Nothing in it is a repository rule. `.claude/settings.json` holds the pre-approved commands it refers to, and `.claude/commands/audit.md` the adversarial review protocol, which loads only when invoked. That path is a symlink to `.agents/skills/audit/SKILL.md`, the same protocol in Codex's skill directory, so there is one file to edit; the guard fails if the link is replaced by a copy.

**The layer `CLAUDE.md` files** are indexes. Claude Code loads one automatically when the agent first touches a file under that directory, so each is read by exactly the tasks that need it. Other tools do not load them on their own, so `AGENTS.md` tells every agent to read the layer file for the layer it touches. Each has the same four parts: commands, layout, a "Need / Use / Never" table, and a "Read when the work touches it" table. The "Need / Use / Never" row is the whole of a rule at this tier: the thing to use and the thing not to, in one line. The reasoning is in the document the "Read when" table names.

**`docs/backend/README.md` and `docs/frontend/README.md`** are the same index again, written for a person browsing `docs/` rather than an agent arriving from the layer file. Each explains the path convention its documents use. The reachability guard checks both indexes, so a new document is listed in both before the suite is green.

## How a rule is written

A rule is added when a human points out a defect in code an AI wrote. `AGENTS.md` says what that means: fix the code, switch to the helper that should have been used, add a regression test that fails on the original mistake, then write the rule down. Where it goes:

1. **The full entry** goes in the `docs/<layer>/*.md` or contract document whose subject it belongs to, with the reasoning, the defect, and the guard that now holds it. If the subject has no document, the entry starts one, and the "Read when" table gets a row for it (the reachability guard below fails until it does).
2. **One line** goes in the layer `CLAUDE.md` "Need / Use / Never" table, or one sentence in `AGENTS.md` when every layer meets it. If the rule does not fit in a sentence, it is not an always-on rule.
3. **A guard**, where the mistake is mechanical: a type, then a lint rule, then a source-scanning test, in that order of preference. `docs/guard-tests.md` has the recipe. A rule the machine checks needs no essay in the instruction file; the guard's failure message says what to use.
4. **Never in an instruction file:** the issue or PR number, the history of the defect, the mechanism of the guard, edge cases, worked examples. The guard below fails an instruction file that carries an issue number.

Enforcement is ranked, and the rank decides how much prose is justified. `docs/adr/0002-invariant-catalog-and-enforcement-ranking.md` records why.

## The guards that hold the shape

| Guard | What it fails |
|---|---|
| `backend/src/common/instruction-files.spec.ts` | An instruction file over its ceiling; a `docs/backend/` or `docs/frontend/` document not named in both its layer `CLAUDE.md` and its `docs/<layer>/README.md`; an issue or PR number in any instruction file; `.claude/commands/audit.md` no longer a symlink to the Codex skill |
| `backend/src/common/doc-paths.spec.ts` | A path named in `docs/` or an instruction file that does not resolve in the tree |
| `scripts/check-docs-manifests.mjs` | A documented path, `npm run` script, Compose command or Helm default that does not match the repository |
| `.github/workflows/pr-checklist.yml` | A PR missing its approved discussion, an unticked template box |

The ceilings are listed under "Do not change these casually" in `AGENTS.md`. They may be lowered as a file shrinks and are never raised to admit a paragraph. When a file is at its ceiling and a rule must be added, something already there moves down a tier: a subject-specific row leaves the "Need / Use / Never" table for its `docs/<layer>/` document, and the table keeps the rows nearly every change meets.

## What an agent reads for a task

The "Before you act, read" table in `AGENTS.md` is the contract. In practice:

- **A query, service or entity**: `backend/CLAUDE.md`, then the `docs/backend/` rows its table names. The database door, `withScopedDb`, is in `AGENTS.md` itself because every backend change meets it.
- **A component, hook or store**: `frontend/CLAUDE.md`, then the `docs/frontend/` rows. `docs/frontend/ui-conventions.md` and `docs/frontend/financial-figures.md` are the two largest; the table's row names the part of the subject so the reader can grep within them.
- **Anything that moves money**: `docs/financial-semantics.md`, `docs/financial-calculation-contract.md`, `docs/time-series-contract.md`, and the invariant entries to cite. The financial-math list in `AGENTS.md` is the one-sentence index over these.
- **A migration**: `database/CLAUDE.md` in full. It is short enough to be read whole.
- **A spec, a plan, an ADR**: `docs/specs/` before a financial feature; `docs/future-plans/` before multi-PR work; `docs/adr/` before revisiting a decision.
- **A PR**: `CONTRIBUTING.md` and `.github/pull_request_template.md`.

`docs/system-invariants.md` is read by ID. Its index (the "Index" section near the top) maps each ID to its section; grep for the ID to reach the entry. Reading the file through is never the intent.

## Known pressure points

These are where the shape is under strain and what to do when it gives.

- **The "Need / Use / Never" tables are the new growth vector.** They hold around forty rows each. A row that names one feature's helper (a bond valuation close, a calendar month grid, one report's toolbar) is a subject rule wearing an every-change rule's clothes. When a layer file nears its ceiling, those rows move to their `docs/<layer>/` document and the "Read when" row for that subject absorbs them.
- **Stray sentences after the tables.** A single-feature rule appended below "Before you finish" or between the table and the next heading is a rule filed where no reader is sent. It belongs in the subject document, with a table row if it is truly every-change.
- **Top-level `docs/*.md` has no reachability guard.** The guard covers `docs/backend/` and `docs/frontend/` only. A contract or runbook at the top level that no instruction file names is reachable only by someone who already knows it exists.
