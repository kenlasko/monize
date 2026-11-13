---
title: "Next 'Failed to find Server Action' with no id is a multipart POST"
author: Node
date: 2026-11-13
branch: claude/issue-2156
cost: { minutes: 1, tokens: 27297 }
touches:
  - docs/frontend/api-and-cache.md
  - frontend/src/proxy.test.ts
  - frontend/src/proxy.ts
---

## Decided
The frontend has no Server Actions, so Next 16's action handler hits `!hasServerActions()` for every possible action and logs "Failed to find Server Action" at WARN. A possible action is a POST with a `Next-Action` header OR a multipart/form-data body (`server/lib/server-action-request-meta.js`). `src/proxy.ts` `isPossibleServerAction` refuses both on page paths (after the API/OAuth/MCP branch, before the auth check) with Next's own answer: 409, `x-nextjs-action-not-found: 1`, text/plain "Server Action unavailable.".
## Tried and ruled out
Refusing only requests with the `Next-Action` header: the logged line had no quoted id, so `actionId` was null and the header was absent. A header-only check stops none of the logged traffic.
## Watch out
Read the message shape before guessing the trigger: `getActionNotFoundError(id)` quotes the id when there is one. URL-encoded POSTs without the header bail out before logging, so they need no refusal. Adding the first Server Action means deleting the refusal; the guard in proxy.test.ts says so.
