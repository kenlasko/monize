---
title: "web-push 4 is ESM-only: Jest suites fail to load until it is allowlisted"
author: Node
date: 2026-11-15
branch: claude/issue-2186
cost: { minutes: 5, tokens: 35836 }
touches:
  - backend/package.json
  - backend/test/jest-e2e.json
  - backend/test/jest-integration.json
---

## Decided
- Dependabot's web-push 3.6.7 -> 4.0.0 (#2191, merged to main 2026-11-14) is pure ESM, and so are https-proxy-agent 9, agent-base 9 and proxy-agent-negotiate 1 underneath it. Added all four to transformIgnorePatterns in backend/package.json, test/jest-integration.json and test/jest-e2e.json (kept identical).
- The list came from walking web-push's dependency tree for `"type": "module"`, not from fixing one "Must use import to load ES Module" failure at a time (each fix only reveals the next package).
## Watch out
- CI checks out the PR merged into the latest main, so a dependency bump that lands on main breaks every open PR's integration shards with errors in files the PR never touched. Compare origin/main (`git log <base>..origin/main`) before hunting in your own diff.
- Unit push specs mock web-push and passed without the change; integration-setup.ts reaches the real module through NetWorthService, which is why nearly every integration suite failed.
