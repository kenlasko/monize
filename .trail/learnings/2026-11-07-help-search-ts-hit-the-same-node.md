---
title: help-search.ts hit the same Bearer CWE-208 token-name false positive as payee-auto-merge
author: Node
date: 2026-11-07
branch: claude/issue-2050
cost: { minutes: 5, tokens: 666115 }
touches:
  - backend/src/help/help-search.ts
  - scripts/e2e-playwright.sh
  - ".github/workflows/ci.yml"
---

## Decided
- `backend/src/help/help-search.ts`'s `tokenMatches` (`fieldToken === candidate`) and `excerptCandidates` (`token === "twofactor"`) tripped Bearer's `javascript_lang_observable_timing` rule (CWE-208) in CI, same as `payee-auto-merge.service.ts#longestCommonTokenPrefix` before it: the rule flags any `===`/`!==` whose compared local's name ends in "token", assuming a credential compare, with no dataflow check for what the value actually is.
- Fixed the same way that file already did: renamed the locals away from "token" (`fieldToken` -> `fieldWord`, the `excerptCandidates` param `token` -> `word`) rather than adding a CI `exclude-fingerprint` entry. Verified with `bearer scan backend/src/help/help-search.ts --hide-progress-bar` locally (installed via the official `contrib/install.sh`, pinned to v2.1.3 to match `scripts/e2e-playwright.sh`'s CI version note): 2 findings before, 0 after.

## Tried and ruled out
- Adding two more entries to the long `exclude-fingerprint` list in `.github/workflows/ci.yml`: the rename is cheaper, needs no review-by date, and is the documented preference (see the comment left on the original payee fix).

## Watch out
- Any new local in this file compared with `===`/`!==` whose name ends in "token" (not just literally `token`) will re-trip this rule. Keep calling these "word" or similarly, as the rest of the file now does.
