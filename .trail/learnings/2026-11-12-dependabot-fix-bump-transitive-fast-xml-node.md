---
title: "Dependabot fix: bump transitive fast-xml-parser via mdb-reader"
author: Node
date: 2026-11-12
branch: claude/issue-2127
cost: { minutes: 4, tokens: 73032 }
touches:
  - backend/package-lock.json
  - backend/package.json
  - package.json
---

## Decided
Fixed Dependabot alert #122 / code-scanning alert #232 (CVE-2026-126066, GHSA-474x-hrwr-fgx4, fast-xml-parser quadratic rescan DoS under non-default stopNodes) by bumping the transitive fast-xml-parser dependency pulled in via mdb-reader (backend's Microsoft Money .mny import) from 5.10.1 to 5.12.0. Only backend/package-lock.json changed — mdb-reader's own dependency range (^4.0.0 || ^5.0.0) already permits 5.12.0, and backend/package.json has no direct dependency on fast-xml-parser.

## Tried and ruled out
`npm audit fix` did not flag this advisory at all (its local advisory DB didn't have GHSA-474x-hrwr-fgx4 yet), so audit-fix alone is not reliable for freshly-published advisories — resolve the specific package instead.
Did not add package.json `overrides` — unnecessary since the existing semver range already covers the patched version.

## Watch out
`npm update <transitive-pkg> --package-lock-only` successfully bumps a nested/transitive dependency in place (here it also pulled along fast-xml-parser's own sub-deps: @nodable/entities, fast-xml-builder, is-unsafe, strnum) as long as the parent package's declared semver range already covers the target version. No node_modules install is required to do this, but verify with a real `npm ci` + the affected test suite afterward (ran `npx jest --maxWorkers=1 src/import/mny`, 46 suites / 1149 tests passed) since the lockfile edit alone doesn't prove the new version behaves correctly.
`npx tsc --noEmit` OOMs on this worker's default heap on this repo size — unrelated to this change, just a worker-memory limitation to expect.
