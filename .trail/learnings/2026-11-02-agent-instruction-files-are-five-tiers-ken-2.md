---
title: Agent instruction files are five tiers held by byte ceilings; the layer Need/Use/Never tables are where growth now lands
author: Ken
date: 2026-11-02
branch: main
id: l-7d15d535
scope: repo
status: active
replaces: l-ddd68706
src: agent
touches:
  - AGENTS.md
  - CONTRIBUTING.md
  - backend/src/common/instruction-files.spec.ts
  - docs/agent-instructions.md
  - scripts/check-docs-manifests.mjs
  - backend/CLAUDE.md
  - CLAUDE.md
  - ".agents/skills/audit/SKILL.md"
---

## Decided
- The way the repo instructs agents is written down once, in docs/agent-instructions.md: always-on repo files, always-on layer indexes, on-demand subject docs, records (invariants, ADRs, plans), and trail learnings. AGENTS.md's organisation section was condensed to point at it, which freed about 170 bytes under its 26 KiB ceiling (it had 17 bytes left; backend/CLAUDE.md has 21).
- The reachability guard now checks both indexes per layer, the layer CLAUDE.md and docs/<layer>/README.md, so neither hand-written table can drift.
- The audit protocol is one file: .claude/commands/audit.md is a committed symlink to .agents/skills/audit/SKILL.md, and a guard fails if the link becomes a copy. A review that compares the two by bytes sees them identical and wrongly reports a duplicate; check for the symlink first.
- The shape is sound; the strain is in the layer "Need / Use / Never" tables (about 40 rows each) where single-feature rows are filed as every-change rules, and in stray single-feature sentences appended after "Before you finish".

## Tried and ruled out
- A byte-equality guard for the audit files: it reads through the symlink and can never fail.
- Moving the table rows down a tier in the same change: each row needs a judgement about whether it is truly every-change, so it is its own PR.
- Formatting the doc with Prettier: the repo's Markdown tables are hand-compact and AGENTS.md already fails prettier --check; md is not in lint-staged.

## Watch out
- Top-level docs/*.md has no reachability guard; eight documents (gem-strategy, import-ms-money, ms-money-data-model, rls-runbook, shared-helpers, support-backup, security-benchmark-comparison, import-csv-investment-spec) are named by no instruction file.
- trail check flags any AGENTS.md edit with a word-overlap false positive against the "800-line file limit" learning.

In the code: docs/agent-instructions.md, AGENTS.md "How the instruction files are organised", backend/src/common/instruction-files.spec.ts (ceilings, INDEXED_LAYERS, SYMLINKED_FILES), scripts/check-docs-manifests.mjs DOCS list.
