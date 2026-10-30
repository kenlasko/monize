---
title: "CodeQL password heuristic: which string arguments count as a source"
author: Node
date: 2026-10-30
branch: claude/issue-1951
cost: { minutes: 2, tokens: 23681 }
touches:
  - backend/src/common/codeql-password-source.guard.spec.ts
  - docs/backend/modules-and-runtime.md
---

## Decided
- CodeQL's notSensitiveRegexp starts with `[^\w$.-]`, so a string argument holding any other non-word character (`:`, `/`, `@`) is not read as a password. On issue #1951 the source of the hashToken alert was the bare `"password"` argument to `.replace`, not the URL-shaped argument whose userinfo held the word.
- codeql-password-source.guard.spec.ts is deliberately broader than CodeQL (it also flags URL-shaped arguments) and follows a same-file `const` bound to a password-like literal, because CodeQL's mayHaveStringValue reads through a local const.

## Watch out
- The guard does not follow a `let`, an imported constant or a string built by concatenation; whether CodeQL does was not verified.
- The worker's pre-push secret scan flags any URL literal carrying a user and a secret before the host, fake or not, in code, learnings and commit messages. Build fixture URLs with `simplefinAccessUrl` and describe them in prose without spelling one out.
