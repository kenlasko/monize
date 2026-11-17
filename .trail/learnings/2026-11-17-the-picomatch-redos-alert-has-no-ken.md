---
title: "The picomatch ReDoS alert has no patched release yet, and the frontend pins picomatch exactly, so the pin must be raised by hand when a fix ships"
author: Ken
date: 2026-11-17
branch: fix/desktop-bearer-path-literal
cost: { minutes: 11, tokens: 31159 }
id: l-a7f41f34
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
- Nothing changed (2026-11-17). Dependabot alert 135, GHSA-fc5q-39xc-vjpf, covers picomatch through 4.0.7, the newest release, so there is no version to move to.
- Not reachable in production: the npm picomatch is pulled in by build, test and dev tooling (vite, vitest, patch-package, next-intl's @parcel/watcher) and is not traced into the frontend's standalone server, which carries only Next's own compiled copy. The attack needs an attacker-supplied glob, and every pattern Monize compiles is written in code or config.

## Watch out
- The frontend's overrides pin picomatch to an exact version, so Dependabot's normal bump will not lift it. When a patched picomatch ships, raise the override in the same change and check `npm ls picomatch --all`.
- The lockfile marks picomatch as not dev-only (it arrives through next-intl), so a scanner that reads only the lockfile counts it as runtime.

In the code:
- frontend/package.json "overrides" (picomatch); frontend/package-lock.json node_modules/picomatch
