---
title: Agent instruction files are five tiers held by byte ceilings; the layer Need/Use/Never tables are where growth now lands
author: Ken
date: 2026-11-02
branch: main
id: l-ddd68706
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - CONTRIBUTING.md
  - docs/agent-instructions.md
  - scripts/check-docs-manifests.mjs
  - backend/CLAUDE.md
  - ".agents/skills/audit/SKILL.md"
  - backend/src/common/instruction-files.spec.ts
---

## Decided
- The way the repo instructs agents is written down once, in docs/agent-instructions.md: always-on repo files, always-on layer indexes, on-demand subject docs, records (invariants, ADRs, plans), and trail learnings. AGENTS.md's organisation section was condensed to point at it, which also freed about 170 bytes under its 26 KiB ceiling (it had 17 bytes left; backend/CLAUDE.md has 21).
- A review of the shape found it sound; the strain is in the layer "Need / Use / Never" tables (about 40 rows each) where single-feature rows have been filed as every-change rules, and in stray single-feature sentences appended after "Before you finish".

## Tried and ruled out
- Moving the table rows down a tier in the same change: each row needs a judgement about whether it is truly every-change, so it is its own PR.
- Formatting the new doc with Prettier: the repo's Markdown tables are hand-compact and AGENTS.md and CONTRIBUTING.md already fail prettier --check; md is not in lint-staged.

## Watch out
- The reachability guard covers only docs/backend and docs/frontend; eight top-level docs/*.md (gem-strategy, import-ms-money, ms-money-data-model, rls-runbook, shared-helpers, support-backup, security-benchmark-comparison, import-csv-investment-spec) are named by no instruction file.
- .claude/commands/audit.md and .agents/skills/audit/SKILL.md are byte-identical copies with no guard keeping them so.
- trail check flags any AGENTS.md edit with a word-overlap false positive against the "800-line file limit" learning.

In the code: docs/agent-instructions.md, AGENTS.md "How the instruction files are organised", backend/src/common/instruction-files.spec.ts (ceilings), scripts/check-docs-manifests.mjs DOCS list.
