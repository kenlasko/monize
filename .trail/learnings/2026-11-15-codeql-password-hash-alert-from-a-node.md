---
title: "CodeQL password-hash alert from a spec variable's name (oldPassword)"
author: Node
date: 2026-11-15
branch: claude/issue-2216
cost: { minutes: 24, tokens: 154243 }
touches:
  - backend/src/auth/auth.service.spec.ts
  - backend/src/common/codeql-password-source.guard.spec.ts
  - docs/backend/modules-and-runtime.md
---

## Decided
- Issue #2216: alerts #224 (crypto.util.ts:47 hashToken) and #234 (login-device.ts:48 hmac) both had source "an access to oldPassword": auth.service.spec.ts named a login-device cookie jar (minted under a replaced bcrypt hash) `oldPassword`; it flowed through service.login -> sparedKnownDevice -> verifyLoginDeviceCookie (HMAC) and hashToken(cookie). CodeQL classes every read of a variable with a password-like name as a cleartext password, whatever it holds. Fix: rename to `supersededHash` ("hash" is in notSensitiveRegexp).
- Guard added to codeql-password-source.guard.spec.ts: a variable CodeQL reads as a password whose value is made by createHash/createHmac/bcrypt hash/hashSync, a backend/src function calling one (closure within one file), or a same-file wrapper, fails. "Made by" = the initializer is that call or a method chained on it, after unwrapping await/parens/as.
- Verified with a local CodeQL 2.27.4 run (bundle + `database create` over a `git ls-files backend` copy, ~3 min each for create and analyze at --ram=4096): before, both alerts; after, only the dismissed password-breach.service.ts:27 and push-config.service.ts:107.

## Tried and ruled out
- Banning every password-like binding name in tests: ~90 bindings (service handles, mocks named `oauth`, `PASSWORD` literals reaching bcrypt), none of which reach a fast hash.
- Following hashing functions across files by name: the closure explodes to ~850 names (`create`, `sign`, `perform` call hashes somewhere). Within one file it stays exact.
- Flagging any initializer that merely contains a hashing call: hits msisam-decrypt.ts `passwordProtected = ... && !verifyPassword(...)`, a boolean.

## Watch out
- loan-payment-frequency.guard.spec.ts fails under the worker's America/Toronto TZ and passes with TZ=UTC (CI's zone); unrelated to auth.
