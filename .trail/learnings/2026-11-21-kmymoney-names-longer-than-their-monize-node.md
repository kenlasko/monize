---
title: KMyMoney names longer than their Monize column are renamed in the raw model before mapping
author: Node
date: 2026-11-21
branch: claude/issue-2313
cost: { minutes: 28, tokens: 355652 }
touches:
  - backend/src/import/kmy/README.md
  - backend/src/import/kmy/map/kmy-name-fixes.spec.ts
  - backend/src/import/kmy/map/kmy-name-fixes.ts
  - backend/src/import/mny/dto/mny-import.dto.spec.ts
  - backend/src/import/mny/model/mny-import-options.ts
  - docs/specs/kmymoney-import.md
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/en/import.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/fr/import.json
---

## Decided
- Issue #2313: a KMyMoney payee from a SEPA direct debit can be hundreds of characters; payees.name is VARCHAR(255) and the INSERT failed the whole job. Ken asked: let the user rename, do the same for every affected field, and never fail the import.
- `applyKmyNameFixes` (backend/src/import/kmy/map/kmy-name-fixes.ts) runs first in `mapKmyFileSteps` over the raw model, so payee_name, a schedule named after its payee, an investment pair's halves and tag links all read the same replacement. Covered kinds: payee, account, category (income/expense/equity accounts), security, schedule, institution (255) and tag (100; it used to be cut silently, which could merge two tags).
- The rename travels as `options.renames` ({kind, handle = ordinal, name}). The preview echoes the cut names as the default, the way `options.bills` is echoed, so a client that sends nothing still imports. The list (`nameFixes`) is computed before renames, so it does not change with what was sent.
- The investment account bound is 255 minus " - " and the longest pair suffix (this locale's and the English one). `fitName` keeps the suffix and a duplicate's " (n)" inside the column.

## Tried and ruled out
- Applying renames to the mapped model (shared with Money): renamed payees would then need re-merging, alias collisions and all. Renaming the raw model lets the existing case-insensitive grouping do it.
- Failing the job with a typed error and asking for a retry: the maintainer said the import must not fail on this.

## Watch out
- Lengths are code points (PostgreSQL VARCHAR, class-validator MaxLength); the frontend input's maxLength counts UTF-16, which is stricter and so safe.
- The preview caps the list at 1,000 entries and each original at 1,000 characters (a KMyMoney attribute can be 1 MiB); the rest are cut and only counted.
- Money (.mny) files ignore renames: Jet text columns already stop at 255.
- ts-jest accepted a call missing an argument that `npm run typecheck` (tsconfig.test.json) refused; run typecheck over test/ too.
