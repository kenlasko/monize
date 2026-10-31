---
title: Guard specs that walk the repo fail in a plain node container because it has no git
author: Ken
date: 2026-10-31
branch: fix/codeql-fixture-secrets
id: l-49755dd7
scope: repo
status: active
src: agent
touches:
  - backend/src/common/repo-tree.util.ts
  - backend/src/common/codeql-password-source.guard.spec.ts
---

## Decided
- To run backend guard specs in node:24-alpine, install git first and mark the mount safe: `apk add git && git config --global --add safe.directory /repo`. Without git, every guard that lists files with gitListFiles fails with "git: not found", which reads like a real guard failure.

## Watch out
- Only the repo-walking guards fail; ordinary unit specs pass in the same run, so a mixed result there is the container, not the change.
- Without safe.directory, git refuses the bind-mounted repo (owned by another uid) and the guard fails the same way.

In the code: backend/src/common/repo-tree.util.ts (gitListFiles runs `git ls-files -z`), used by backend/src/common/codeql-password-source.guard.spec.ts and the other *.guard.spec.ts files.
