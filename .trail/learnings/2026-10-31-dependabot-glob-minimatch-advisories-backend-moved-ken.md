---
title: "Dependabot glob/minimatch advisories: backend moved to glob 14 and minimatch 11; frontend's eslint copy of minimatch 3 is left in place"
author: Ken
date: 2026-10-31
branch: main
id: l-72f93a81
scope: repo
status: active
src: agent
touches:
  - backend/package-lock.json
  - backend/package.json
  - frontend/package-lock.json
  - frontend/package.json
---

## Decided
- Backend: one global override each, "glob": "^14.0.2" and "minimatch": "^11.0.1". These replace the per-parent "glob": "13.0.0" pins (typeorm, jest-config, jest-runtime, @jest/reporters) that were added in June to drop the deprecated glob@10.5.0. The global glob override also replaces test-exclude's nested glob 10.5.0. Every backend consumer already used the named-export API, and TypeORM's entity pattern (src/**/*.entity{.ts,.js}) and the Nest i18n asset pattern match the same files under both versions.
- Frontend: a scoped override, "minimatch@>=10": "^11.0.1", which moves only @typescript-eslint/typescript-estree's copy. The top-level minimatch 3.x used by eslint and its plugins stays until those plugins move off minimatch 3. That copy is dev-only, and lint patterns come from config, not from users.

## Tried and ruled out
- A global "minimatch": "^11.0.1" in the frontend. minimatch 4+ has no default export. eslint-plugin-react, eslint-plugin-jsx-a11y and eslint-plugin-import call `minimatch(...)` or `_minimatch2.default(...)`, so a rule given a pattern option (for example react/jsx-pascal-case with `ignore`) crashes ESLint with "TypeError: minimatch is not a function". A plain lint run can still pass, because only rules with pattern options reach that call.

## Watch out
- minimatch 11 is a new matching engine, not only a renamed API. Before trusting a bump, compare what the runtime glob patterns match under the old and new versions.
