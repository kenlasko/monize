---
title: "CodeQL password-hash alert on hashToken: source was a spec's .replace(\"password\", ...)"
author: Node
date: 2026-10-30
branch: claude/issue-1951
cost: { minutes: 9, tokens: 106237 }
touches:
  - backend/src/bank-sync/providers/simplefin/simplefin.provider.spec.ts
  - backend/src/common/codeql-password-source.guard.spec.ts
  - backend/test/integration/simplefin-discovery.integration.spec.ts
  - backend/test/integration/simplefin-import.integration.spec.ts
  - backend/test/integration/simplefin-storage.integration.spec.ts
  - docs/backend/modules-and-runtime.md
---

## Decided
- js/insufficient-password-hash on crypto.util.ts hashToken with "Password from a call to replace": CodeQL's SensitiveCall treats any call with a string-constant argument matching its password heuristic as returning a password. simplefin.provider.spec.ts built its rotated accessUrl via `.replace("password","rotated")`, which flows into readAccount -> hashToken(accessUrl). Fix: build fixture URLs with `simplefinAccessUrl` (bank-sync-testing.ts, sets URL.username/password; a plain literal is not a CodeQL source, but a literal credential-bearing URL trips the pre-push secret scan); guard `backend/src/common/codeql-password-source.guard.spec.ts` bans replace/replaceAll with a password-like literal arg under backend/src and backend/test.
- To find the source of a "Password from a call to X" alert: grep for `.X(` calls whose string args contain password/passcode/oauth/authkey, including spec files; CodeQL default setup analyzes specs.
- deepmerge 4.3.1 (prototype poisoning): only a dev dep of jest-config 30.5.2 (latest Jest still requires ^4.3.1; deepmerge has no fixed release). Used as deepmerge.all([defaults, overrides]) and deepmerge(preset.globals, options.globals) on our own Jest config. Switching it needs an npm override to an API-compatible shim (deepmerge-ts and @fastify/deepmerge are not drop-in), which is a dependency change that needs maintainer agreement.

## Tried and ruled out
- Changing hashToken to HMAC/a slow hash: breaks every stored token lookup, and HMAC is still a CodeQL crypto sink.
- Touching crypto.util.ts:47: re-reports the alert as new in the PR.

## Watch out
- Keep a redaction assertion's secret word: the provider spec checks `not.toContain("password")`, so the literal must still contain "password".
- `npm run typecheck` OOMs with the default heap here; use NODE_OPTIONS=--max-old-space-size=4096.
