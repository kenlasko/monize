---
title: "deepmerge Dependabot alert: dismissed, not overridden"
author: Node
date: 2026-10-30
branch: claude/issue-1951
cost: { minutes: 1, tokens: 16864 }
---

## Decided
- Ken chose (issue #1951) to dismiss the deepmerge <=4.3.1 prototype-poisoning alert on the Security tab rather than override it. deepmerge is only a dev dependency of jest-config (latest Jest still requires ^4.3.1, no fixed deepmerge exists), and it only merges Jest's defaults/presets with the repo's own jest config, so no untrusted input reaches it.

## Tried and ruled out
- An npm `overrides` entry pointing deepmerge at a local shim over deepmerge-ts: offered, declined as a dependency/lockfile change to maintain until Jest drops deepmerge.

## Watch out
- If the alert resurfaces, check whether a newer Jest dropped deepmerge before proposing an override again.
