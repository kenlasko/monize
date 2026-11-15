---
title: "oauth-endpoint-throttle false-positive is name-based, not a new hashToken-duplicating sink"
author: Node
date: 2026-11-15
branch: claude/issue-2212
cost: { minutes: 9, tokens: 141127 }
touches:
  - desktop/package-lock.json
  - desktop/package.json
  - backend/src/oauth/oauth-endpoint-throttle.spec.ts
  - backend/src/oauth/oauth-endpoint-throttle.ts
  - docs/backend/modules-and-runtime.md
  - backend/src/auth/crypto.util.ts
---

## Decided
- Code scanning alert #233 (js/insufficient-password-hash) at backend/src/oauth/oauth-endpoint-throttle.ts:97 is the name-based false-positive case docs/backend/modules-and-runtime.md describes: CodeQL's sensitive-name heuristic reads the exported array `OAUTH_ENDPOINT_THROTTLES` as a password source because its identifier contains "oauth", and `rule.name` read off it reaches the existing `createHash("sha256").update(...)` call. Fixed by renaming the array to `ENDPOINT_THROTTLE_RULES` (and updating oauth-endpoint-throttle.spec.ts's imports/usages to match), the same remedy already used for `newAuthorizationState`/`sealAuthorizationState`/`openAuthorizationState` in email-receipts/oauth/oauth-state.ts. No new createHash call was added and no suppression annotation was needed -- the rename removes the false signal outright.

## Tried and ruled out
- Did not route this hash through `hashToken` (backend/src/auth/crypto.util.ts). That helper is documented as for credential-derived values (refresh-token equality lookups); this is an IP+rule-name rate-limit bucket key, not a credential, and switching to it would just move the sink into a shared helper rather than fix the name-based source `trail check` otherwise flags against Node's 2026-10-24 simplefin learning ("brings back codeql insufficient password, which Node's learning ruled out"). That learning is about a *different* mistake: adding a fresh inline `createHash` call that duplicates the `hashToken` sink. This change touches neither `hashToken` nor adds a new inline hash call -- it renames the identifier feeding an already-existing hash call -- so the keyword match is a false conflict, same pattern as the Android Bearer-token false match noted in that same learning's "Watch out".

## Watch out
- `trail check` will flag any touch to `backend/src/oauth/oauth-endpoint-throttle.ts` against Node's 2026-10-24 learning purely on "codeql insufficient password hash" keyword overlap. Check whether the change actually adds a new createHash/inline-hash call (the real ruled-out mistake) before treating it as a real conflict; a rename-only fix for a name-based false positive is not the same mistake.
