---
title: "After merging main into a branch that edits the user guide, rebuild the docs even when the merge reported no conflict"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-589ab8c5
scope: repo
status: active
src: agent
touches:
  - website/docs/search-index.json
---

## Decided
After main is merged into a branch that changed website/docs, run npm run docs:build again and commit what it changes, even when git merged cleanly. This is needed because a clean merge can keep one side's generated search index, which then matches neither side's Markdown. Otherwise Frontend Unit Tests fails with "website/docs is out of date with its Markdown (search-index.json)".

## Watch out
GitHub's "Update branch" button merges on the server with no local build, and the PR's CI tests that merged tree, so the failure shows up only there, about 5 minutes into the frontend shard.

In the code:
- frontend: npm run docs:build, npm run docs:check (the check website-docs.test.ts runs)
- website/docs/search-index.json, one entry per line
