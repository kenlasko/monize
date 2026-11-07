---
title: a WeakMap memoization cache needs no process-local-state allowlist entry
author: Node
date: 2026-11-07
branch: claude/issue-2050
cost: { minutes: 50, tokens: 212267 }
touches:
  - docs/future-plans/in-app-help-search-tasks.md
  - backend/src/help/dto/help-search-query.dto.ts
  - backend/src/help/help-search.spec.ts
  - backend/src/help/help-search.ts
  - backend/src/help/help.controller.spec.ts
  - frontend/src/components/help/HelpSearchDialog.test.tsx
  - frontend/src/components/help/HelpSearchDialog.tsx
  - backend/src/help/help.service.ts
  - frontend/src/lib/helpers/is-editable-target.test.ts
  - frontend/src/lib/helpers/is-editable-target.ts
---

## Decided
- `help-search.ts`'s `tokenCache` (a module-level `WeakMap<HelpSearchSection, Tokenized>` memoizing the pure `tokenize()` output per section, added so `searchHelp` doesn't re-tokenize the whole bundled guide on every `GET /help/search` call) needs no entry in `process-local-state.guard.spec.ts`'s `ALLOWED` map.
- The guard's own doc comment says it does not match `WeakMap`/`WeakSet` at all, and its regex only matches `private`/`protected` CLASS fields assigned `new Map`/`Set`/`EmptyWindowMemory` -- confirmed no `WeakMap` key exists anywhere in `ALLOWED` today. A WeakMap keyed on the section objects HelpService already holds forever is exactly the "cache, not a guard; a miss costs a cheap recomputation, changes no row" category several `Map`-based caches in that same allowlist already cover (e.g. `security-news.service.ts#cache`) -- just one the mechanical scan was never meant to reach.

## Tried and ruled out
- Treating `trail check`'s hit on this line as the same "hiding a cache so the guard's pattern misses it" anti-pattern Ken's `2026-11-06-help-guide-cache-is-an-allowlisted-ken` learning ruled out: that case was a class field restructured specifically to dodge the regex while still being the same per-replica *business* state (`this.loaded` et al., which ARE allowlisted). This case is a derived-data memoization of an already-immutable, already-cached source (`HelpService.sections`), using the one container type (`WeakMap`) the guard's authors explicitly carved out as out of scope.

## Watch out
- If a future class-field `Map`/`Set` cache is added near this one, it DOES need an `ALLOWED` entry (the regex will catch it); only the `WeakMap` shape is exempt.
