---
title: "A blanket fs.readFileSync stub breaks Jest's own source-map reads"
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 3, tokens: 22673 }
touches:
  - backend/src/db-init.spec.ts
---

## Decided
- db-init.spec.ts fakes fs.existsSync / fs.readFileSync only for paths ending in schema.sql, and passes every other path to the real functions (captured at module scope before the spies).
## Watch out
- A spec that stubs `fs.readFileSync` for every path also feeds Jest's internals: formatting an error's stack can read a source map through the same fs, which then fails with "SyntaxError ... convert-source-map" in an unrelated test.
- It depends on whether Jest needs that map, so it flakes on CI under coverage and does not reproduce locally. Scope fs stubs to the path under test.
