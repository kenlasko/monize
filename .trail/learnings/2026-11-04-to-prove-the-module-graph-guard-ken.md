---
title: "To prove the module-graph guard still catches a cycle bug, plant one on an edge the static check reports; most forwardRefs are not on a cycle"
author: Ken
date: 2026-11-04
branch: perf/ci-test-speed
id: l-b892951d
scope: repo
status: active
src: agent
touches:
  - backend/src/module-graph.spec.ts
  - backend/src/accounts/accounts.module.ts
---

## Decided
- To check a change to the module-graph spec, turn one forwardRef module import back into a bare import and compare which cases fail under the old and the new spec. Identical failures mean the guard lost nothing.

## Tried and ruled out
- Planting on an arbitrary forwardRef edge (EmailReceiptParsersModule -> PayeesModule, McpModule -> AccountsModule): neither is on a require cycle, so both versions pass and the comparison proves nothing.

## Watch out
- Get real cycle edges from the spec's own static analysis: replace every forwardRef(() => XModule) with XModule in memory and pass the result to bareEdgesOnRequireCycles. accounts.module.ts -> CategoriesModule is one; planting it fails the static check and the "categories/categories.module.ts loads first" runtime case.
- Without --verbose, Jest marks failures with "●", not "✕"; a grep for "✕" silently reports none.

In the code: backend/src/module-graph.spec.ts (exports bareEdgesOnRequireCycles), backend/src/accounts/accounts.module.ts line with forwardRef(() => CategoriesModule).
