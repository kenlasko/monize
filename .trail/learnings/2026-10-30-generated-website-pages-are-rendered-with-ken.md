---
title: "Generated website pages are rendered with React, never escaped by hand, because Bearer fails CI on manual HTML escaping"
author: Ken
date: 2026-10-30
branch: docs/website-user-guide
id: l-3cafdf41
scope: repo
status: active
src: agent
touches:
  - frontend/scripts/build-website-docs.mjs
  - frontend/scripts/website-docs/markdown.mjs
  - frontend/scripts/website-docs/template.mjs
  - website/README.md
  - website/docs/accounts.html
  - website/docs/ai.html
  - website/docs/backup-and-restore.html
  - website/docs/bills-and-deposits.html
  - website/docs/budgets.html
  - website/docs/categories-and-payees.html
---

## Decided
- The docs page shell is a React tree rendered with renderToStaticMarkup, and the Markdown body is placed in it as an element. React does all escaping; no string of markup is spliced in.
- The docs pages' theme bootstrap is an external blocking script rather than inline script text, so the shell needs no raw HTML.

## Tried and ruled out
- A hand-written escape function (a chain of .replace for & < > " '): Bearer's javascript_lang_manual_html_sanitization rule reports it as HIGH CWE-79 and the Bearer Security Scan job fails, even in a build script that never ships in an image.
- Adding a Bearer exception, or pulling in `he` (a backend-only dependency) for the frontend: both need agreement here; React already escapes.

## Watch out
- No Bearer binary is installed locally, so a finding like this shows up only in CI.

In the code: frontend/scripts/website-docs/template.mjs, frontend/scripts/website-docs/markdown.mjs (renderPage renders twice: once to collect title and table of contents, once inside the shell), website/assets/js/theme-boot.js.
