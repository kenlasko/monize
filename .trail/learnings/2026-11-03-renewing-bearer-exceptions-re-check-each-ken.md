---
title: "Renewing Bearer exceptions: re-check each reason, then push it as a PR"
author: Ken
date: 2026-11-03
branch: claude/issue-1994
id: l-3e21df60
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - scripts/check-bearer-exceptions.mjs
---

## Decided
Renewing an overdue Bearer exception means checking its written reason against the current source first. Move only the review-by date (about 3 months out) once the reason still holds. Fingerprints and skip rules stay as they are. If the code a reason points to has moved, update the comment.

## Tried and ruled out
Recovering the earlier worker's unpushed commits from its pod: exec into claude-worker-2 was denied. Redoing the renewal by hand was quicker.

## Watch out
A worker's "Work complete" comment on an issue does not mean it pushed anything (issue 1994's run never did). Before redoing the work, look for the branch on the remote. A renewal that never merges leaves the dates stale and reopens the same weekly issue (as with 1877).

In the code: .github/workflows/ci.yml (the Bearer exclude-fingerprint comment block); check with `node scripts/check-bearer-exceptions.mjs` (fails on overdue, warns within 14 days); look for the branch with `git ls-remote origin 'refs/heads/claude/issue-<n>'`.
