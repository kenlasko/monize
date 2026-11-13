---
title: "Next 'Failed to find Server Action' log noise"
author: Node
date: 2026-11-13
branch: claude/issue-2156
cost: { minutes: 7, tokens: 49943 }
touches:
  - docs/frontend/api-and-cache.md
  - frontend/src/proxy.test.ts
  - frontend/src/proxy.ts
---

## Decided
The frontend defines no Server Actions (no "use server" in frontend/src), so every POST carrying a `Next-Action` header is a scanner or a foreign client. `src/proxy.ts` answers it 404 with `x-nextjs-action-not-found: 1` (what Next itself returns, which a stale client router treats as "reload") before Next's action handler logs a WARN with stack. A guard in `proxy.test.ts` fails if a "use server" module appears.
## Tried and ruled out
Refusing every non-API POST to a page path: broader than the observed noise, and Next's MPA form-action detection (multipart/urlencoded without the header) is not what produced the warning.
## Watch out
Adding the first Server Action means deleting the proxy refusal; the guard says so.
