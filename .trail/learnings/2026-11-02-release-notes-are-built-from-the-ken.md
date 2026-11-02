---
title: "Release notes are built from the commits on main since the last tag, not from a merged-PR search"
author: Ken
date: 2026-11-02
branch: main
id: l-c7151fdb
scope: repo
status: active
src: agent
touches:
  - scripts/check-docs-manifests.mjs
---

## Decided
Find what a release contains by listing first-parent commits on main since the previous tag, then match those to PRs. Read the PR bodies for the detail, and check any commit on main that has no PR number.

## Tried and ruled out
Using `gh pr list --search "merged:>=<tag date>"` on its own: it picks up PRs merged before the tag on the same day, and it misses work committed straight to main. In 1.20.0 that was the Microsoft Money 97-99 import, a headline feature, which only showed up in a check for commits with no PR.

## Watch out
The full PR bodies come to roughly 770 KB per release. Cutting each one to its first ~1600 characters, dropping HTML comments and skipping Dependabot PRs leaves about 150 KB, which is enough to write from. Dependabot shows up as `app/dependabot` in gh output; the All Changes list writes it as `@dependabot`. Before stating anything about migrations in "For operators", read the migration headers: some carry data fills or RLS policy changes, and one was rewritten as a no-op after merging.

In the code:
- PRs in range: `git log v<prev>..HEAD --first-parent --format=%s | grep -oE '#[0-9]+'`, intersected with `gh pr list --state merged --json number,title,author`
- Direct commits: `git log v<prev>..HEAD --first-parent --no-merges --format='%h %s' | grep -vE '\(#[0-9]+\)$'`
- Shape check: the What's New parser spec (`npx jest src/updates/release-notes.parser.spec.ts` in backend/) and `node scripts/check-docs-manifests.mjs`
