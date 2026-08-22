# Monize Universal Adversarial PR Review Protocol

**Status:** active · **Executable form:** `/audit` (`.claude/commands/audit.md`)

This document records the protocol's provenance, its two-layer structure, and how to revise it.
The **operational prompt is `.claude/commands/audit.md`**, and it is self-contained: every lens in
it is mandatory, so none of it may be deferred, summarised, or loaded on demand.

## Provenance

The protocol has two sources, and they are layered deliberately:

1. **`docs/audits/monize-universal-adversarial-pr-review-project-prompt.md`** — the superordinate
   layer, committed verbatim beside this file so the protocol can be reconciled against its own
   source rather than against anyone's account of it. The `/audit` command implements this
   document's requirements directly, section by section, in its original order and wording. It is
   the authority on the review process: what is read, what is traced, what must be attacked, what
   may be trusted, what a finding must contain, and when `APPROVE` is permitted.
2. **The V3 improvements document** — the calibration layer. Its rules 1–10 supplement the
   protocol where the protocol does not already legislate; they never replace it.

An earlier revision of this file reconstructed the adversarial layer from a 31-row conformance
table rather than from the source document. That reconstruction covered roughly 40% of the
document's actual content and has been replaced. **Do not reconstruct this protocol from a
summary, a table, or a review of it.** Reconcile against the source document itself.

## How the two layers combine

The calibration rules are placed where they act, not collected at the end:

| V3 rule | Where it lives in `/audit` | Relationship to the protocol |
|---|---|---|
| 1 — finding-admission gate | `# Finding admission and attribution` | Adds a six-question gate and the `DESIGN RISK` outcome to the protocol's "report only realistic, reproducible issues". |
| 2 — contract-precedence gate | `# Finding admission and attribution` | Extends "do not assume a test is authoritative when it contradicts a documented invariant" to shared-helper and consolidation proposals. |
| 3 — PR causality classification | `# Finding admission and attribution` | New; the protocol has no causality taxonomy. Severity is decided after it. |
| 4 — read-model semantic migration | `# Map the complete change surface` | A named special case of the protocol's repo-wide producer/consumer audit. |
| 5 — upstream dependency mutation matrix | `# Map the complete change surface` | Adds the invalidation chain for cached derived financial values. |
| 6 — performance finding calibration | `# External/provider lookup review` | Adds an evidentiary bar (`N/S/K` model or benchmark) to the protocol's "measure or reason about the number of external calls as N grows". |
| 7 — one finding per violated invariant | `# Finding admission and attribution` | New; governs finding count across surfaces. |
| 8 — rejected-hypothesis table | `# Finding admission and attribution` | Formalises the ledger's "false positives rejected" into a required table. |
| 9 — external-review categories | `# Treat summaries and review comments as hypotheses` | Adds the five categories, notably `CONFIRMED_WITH_DIFFERENT_ROOT_CAUSE`, to the protocol's independent-reconstruction rule. |
| 10 — fix-review interaction test | `# Mandatory suggested fix diff` | Sits beside the protocol's rule 20 self-inspection; asks specifically which earlier regression or documented exception the patch would revert. |

No calibration rule overrides a protocol requirement. Where the protocol is stricter — for
example its `Confidence` scale of `high` / `medium` / `low`, or its 15-field finding format — the
protocol's form is used.

## What the protocol requires, in brief

Read `/audit` for the authoritative text. The spine:

- **Language** — conversation with the user in Polish; all maintainer-facing technical material
  in English.
- **Read-only** — no file changes, commits, branches, PRs, reviews, comments, thread resolutions,
  labels or settings changes. Suggested diffs are artifacts and are never applied.
- **`PR_REVIEW_SHA`** — every read pinned to one revision; an approval of SHA A is not an approval
  of SHA B; head movement re-opens the affected invariants and the approval challenge.
- **Instructions before implementation** — every `AGENTS.md`, `CLAUDE.md`, `README`,
  `CONTRIBUTING`, package- and directory-level file, and the relevant `docs/` contracts; scope by
  directory; a test is not authoritative against a documented invariant.
- **Nothing is trusted** — not summaries, commit messages, PR descriptions, prior AI conclusions,
  prior `APPROVE` decisions, other reviewers' comments, or test names.
- **Invariant model first**, in eleven categories, with a
  `producer -> transformations -> storage -> consumers -> side effects` spine per material
  invariant.
- **Complete change surface** — repo-wide producer/transformer/persistence/consumer/secondary-
  consumer/fixture/adapter searches; unchanged callers are part of the review.
- **Mandatory lenses** — cross-layer, representation boundary, browser round-trip,
  server-authoritative metadata, identity vs value, state machine, concurrency/idempotency,
  partial failure, external provider, database/migration, backup/restore, financial and loan/debt,
  auth/RLS.
- **Evidence is not proof** — test false-confidence patterns, mutation analysis, a fresh
  counterexample per invariant, and at least one cross-invariant interaction before `APPROVE`.
- **Every confirmed finding carries a suggested remediation diff** against `PR_REVIEW_SHA` under
  twenty rules, plus a regression-test diff where practical, and an adversarial self-inspection of
  the patch.
- **The approval challenge** — a separate phase that must not begin by re-reading old findings and
  starts from the PR's new abstractions.
- **The merge gate** — ten checks; hosted CI unavailability is stated, never assumed green, and
  locally reported tests are never converted into verified CI results.
- **Finding standard, severity calibration, review ledger, exact verdict**, and a re-review
  procedure that treats a previous `APPROVE` as possibly wrong.

## Monize grounding

The protocol is written to be repository-independent. `/audit` adds a `> **Monize.**` note under
each section naming where that requirement bites here — the invariant index and contract set, the
consumer surfaces that have been missed before (AI executor, MCP tools, dashboard, budgets,
reports, CSV/PDF, `frontend/src/types/*`), the `withScopedDb` and RLS-context rules, the FX and
completeness-flag rules, `schema.sql` parity and migration idempotency, the sharding and
`isShardableId` rules, `applyRegisterOrder`, `deletionBalanceEffect`, `applyActionToQuantity`, the
source-scanning guard tests, and how to run the suites the way CI does.

These notes add targets. They never grant an exemption from a protocol requirement.

## Reconciliation

`/audit` was verified against the source document requirement by requirement: 410 requirement
strings drawn from all 34 sections, checked whitespace-insensitively, 0 missing.

Re-run that reconciliation after any edit, against
`docs/audits/monize-universal-adversarial-pr-review-project-prompt.md` — the source is in the
repository precisely so this check needs no external file. A paraphrase that drops a list item is
the failure mode this document exists to prevent.

## Revising this protocol

- Reconcile against the source document, never against a summary or a review of it.
- Keep the source's section order, wording and list items intact; the lists are the substance.
- Keep the vertical `text` blocks vertical — they are read as structure, not prose.
- Never let a lens become optional, and never let `APPROVE` precede the approval challenge and the
  merge gate.
- Prefer adding to a `> **Monize.**` note over rewriting a requirement.

## Deliberate deviations from the source

A line-by-line reconciliation checks all 766 content lines of the source against `/audit`. Six do
not appear verbatim, and all six are the same two adaptations — recorded here so they read as
decisions rather than drift. No substantive requirement is among them.

| Source wording | `/audit` wording | Why |
|---|---|---|
| "…in `kenlasko/monize`" | "in the `monize` repository" | Correct for this remote (`WMP/monize`) as well as upstream. |
| "these project instructions" | "these instructions" | The protocol ships as a slash command, not as Claude Project instructions. |
| "Once these project instructions are active…" | "Once this protocol is in place…" | Same reason. |
| The three "Review PR #NNNN. Apply the full project review protocol…" examples | The same three, phrased as `/audit <n>` invocations | The invocation surface is the command; the priority hints are preserved verbatim. |

Anything else that fails the reconciliation is a regression, not a deviation.
