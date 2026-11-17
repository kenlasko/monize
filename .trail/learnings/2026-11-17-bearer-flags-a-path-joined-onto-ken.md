---
title: "Bearer flags a path joined onto a function parameter even when the value is a constant, so build such paths from literals"
author: Ken
date: 2026-11-17
branch: fix/desktop-bearer-path-literal
cost: { minutes: 16, tokens: 49924 }
id: l-995ce1a9
scope: repo
status: active
src: agent
touches:
  - desktop/resources/backend-deps.cjs
  - desktop/README.md
  - desktop/eslint.config.mjs
  - desktop/package-lock.json
  - desktop/package.json
  - desktop/scripts/dev-boot.mjs
  - desktop/scripts/lib/pack-deps.mjs
  - desktop/scripts/lib/stage.mjs
  - desktop/scripts/prune.test.mjs
  - desktop/scripts/stage.test.mjs
---

## Decided
- A new finding that only comes from how a path is written is fixed in code, not added to exclude-fingerprint: the desktop's backend-deps preload joined "resolve-anchor.js" onto a parameter that was always the constant archive path, and Bearer's path-traversal rule cannot follow that. Building the path from __dirname and literals at module level cleared it.

## Tried and ruled out
- Reading the findings from the failing CI job while its workflow run is still going: `gh run view --job ... --log` and the jobs logs API return nothing until the whole run completes, and the job's annotations only say "exit code 1".

## Watch out
- Run Bearer locally to see findings at once; scanning only the changed package is quick. The fingerprint is md5("<rule id>_<path>") plus an instance index, so compare the printed ids against exclude-fingerprint: anything not in the list is the new finding.

In the code:
- docker run --rm -v "$PWD":/tmp/scan -w /tmp/scan bearer/bearer:latest-amd64 scan . --skip-path ".trail,desktop/scripts,desktop/src/test-support,desktop/staging,desktop/release,backend,frontend,e2e,website,docs,helm,database,scripts" --skip-rule "javascript_lang_logger_leak,javascript_express_https_protocol_missing,javascript_lang_exception" --quiet
- .github/workflows/ci.yml Bearer step (skip-rule, skip-path, exclude-fingerprint); desktop/resources/backend-deps.cjs ARCHIVE, ANCHOR_URL
