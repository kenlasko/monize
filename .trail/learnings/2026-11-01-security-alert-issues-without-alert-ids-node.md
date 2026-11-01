---
title: "Security-alert issues without alert IDs: local npm audit only shows known findings"
author: Node
date: 2026-11-01
branch: claude/issue-1982
cost: { minutes: 1, tokens: 27259 }
---

## Decided
- An issue saying "fix the latest code scanning and dependabot alerts" without IDs cannot be resolved unattended: the worker has no GitHub credentials, and CodeQL alerts are invisible locally. Ask for the GHSA/rule IDs.

## Tried and ruled out
- `npm audit` in backend/frontend/e2e/root (2026-11-01) shows only already-handled findings: backend deepmerge (dismissed in #1951) and frontend top-level minimatch 3.1.5 under eslint (deliberately left by 71d52176e). Neither is a "new" alert.

## Watch out
- Don't re-propose forcing minimatch 11 onto eslint plugins (crashes "minimatch is not a function") or a deepmerge override (declined).
