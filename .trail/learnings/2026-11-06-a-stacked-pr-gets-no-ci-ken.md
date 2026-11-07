---
title: A stacked PR gets no CI until it targets main
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-83cdc3fc
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
---

## Decided
- Multi-PR plans (such as in-app help) are opened as stacked PRs: the first into main, the next with the first's branch as its base, so each diff shows one plan.

## Watch out
- The main CI workflow only triggers for pull requests into main or develop, so a stacked PR runs nothing but the Cloudflare Pages preview while its base is another feature branch. It gets the full suite only after the PR below it merges and GitHub retargets it to main (which needs the merged branch deleted), or after you point its base at main yourself.
- Until then, its local checks are the only evidence; say so in the PR body rather than reading the missing checks as green.

In the code:
- .github/workflows/ci.yml: on.pull_request.branches: [main, develop]
- example: #2047 (base feat/help-api) stacked on #2046 (base main)
