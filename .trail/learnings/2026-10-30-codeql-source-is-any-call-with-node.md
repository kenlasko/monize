---
title: "CodeQL source is any call with a password-like literal, not only replace"
author: Node
date: 2026-10-30
branch: claude/issue-1951
cost: { minutes: 24, tokens: 106348 }
touches:
  - backend/src/bank-sync/bank-sync-testing.ts
  - backend/src/bank-sync/providers/simplefin/simplefin.provider.spec.ts
  - backend/src/common/codeql-password-source.guard.spec.ts
  - backend/test/integration/simplefin-discovery.integration.spec.ts
  - backend/test/integration/simplefin-import.integration.spec.ts
  - backend/test/integration/simplefin-storage.integration.spec.ts
  - docs/backend/modules-and-runtime.md
---

## Decided
- After the replace() fixtures were removed, CodeQL (PR #1953) still reported js/insufficient-password-hash on hashToken: the new helper call `simplefinAccessUrl(base, "user", "password")` was itself the source, because CodeQL's SensitiveCall classes ANY call with a password-like string-constant argument as returning a password. Fix: fixture secrets are opaque words (`demo-opaque`), and the guard applies CodeQL's exact maybePassword / notSensitiveRegexp (codeql/concepts SensitiveDataHeuristics.qll) to replace, replaceAll, simplefinAccessUrl and same-file wrappers that call them.
- Reproduce a CodeQL alert locally instead of guessing: download the codeql bundle (github.com/github/codeql-action/releases/latest/download/codeql-bundle-linux64.tar.gz, ~700MB), `codeql database create --language=javascript` over a copy of backend/ only (--ram=4096), then `codeql database analyze` with just the one .ql. Takes a few minutes and prints the full source-to-sink path. The CI check-run annotations are readable without auth at api.github.com/repos/<owner>/<repo>/check-runs/<id>/annotations, but they name only the sink.

## Tried and ruled out
- Guarding every call with a password-like literal: ~200 hits (tr, toContain, describe, backup/auth helpers) that never reach a hash. Guarding every same-file function: still dozens. Only wrappers whose body calls a builder are checked.

## Watch out
- CI's message said "a call to replace" while local CodeQL 2.27.3 named the simplefinAccessUrl call for the same sink; trust the local path.
- Pre-existing open alerts at password-breach.service.ts:27 and push-config.service.ts:107 are documented false positives, not regressions.
