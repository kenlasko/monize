---
title: "Editing website/docs/*.md needs npm run docs:build in frontend/"
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 9, tokens: 18669 }
touches:
  - website/docs/categories-and-payees.html
  - website/docs/search-index.json
---

## Decided
- After any edit to website/docs/*.md, run `npm run docs:build` in frontend/ and commit the regenerated .html and search-index.json together with the Markdown.
## Watch out
- frontend's src/test/website-docs.test.ts (Frontend Unit Tests) fails when the generated pages are stale, even on a backend-only PR that touched the user guide.
- The build script imports react through scripts/website-docs/markdown.mjs, so it needs frontend's node_modules installed (`npm ci`).
