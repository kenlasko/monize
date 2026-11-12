---
title: "Issue #2134 correction: split-tag carry ambiguity and untagged groups"
author: Node
date: 2026-11-12
branch: claude/issue-2134
cost: { minutes: 5, tokens: 23266 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
- carrySplitTags treats a key group as determined when every candidate in it carries no tags, before the sameTags / indistinguishable checks. Without that, one untagged line resent as two lines of the same category (amounts differ) was refused. The earlier learning's "Untagged transactions never throw" was false until this fix.
- The refusal (errors.transactions.splitTagCarryAmbiguous) also fires for ONE tagged candidate resent as two distinguishable lines, so its wording must not say "more than one line" or "different tags".

## Watch out
- When testing a "never refuses" claim for the carry, cover n resent lines > m candidates with distinguishable lines, not only n == m.
