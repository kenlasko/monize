---
title: User docs moved from the GitHub wiki to website/docs as Markdown with committed generated pages
author: Ken
date: 2026-10-30
branch: docs/website-user-guide
id: l-9193913b
scope: repo
status: active
src: agent
touches:
  - frontend/CLAUDE.md
  - frontend/package.json
  - frontend/scripts/build-website-docs.mjs
  - frontend/scripts/website-docs/markdown.mjs
  - frontend/scripts/website-docs/template.mjs
  - frontend/src/test/website-docs.test.ts
  - website/README.md
  - website/_headers
  - website/_redirects
  - website/assets/css/docs.css
---

## Decided
- The user guide lives in website/docs/<slug>.md (lower-case wiki page names, Home became index.md) and is served at monize.net/docs/<slug>. Pages are generated locally and committed because the site deploys to Cloudflare Pages with no build step; a frontend Vitest guard fails when a generated page drifts from its Markdown or a link/anchor does not resolve.
- Rendering reuses the frontend's react-markdown + remark-gfm through renderToStaticMarkup, so no new dependency was needed.
- Heading ids follow GitHub's slug rules so every app help link maps 1:1: github.com/kenlasko/monize/wiki/Page#anchor becomes /docs/page#anchor (page name lower-cased). The in-app links were deliberately left pointing at the wiki for a later change.
- Hand-written per-page tables of contents were removed; the site generates "On this page" from ## and ### headings.
- The "update docs with the feature" rule went into frontend/CLAUDE.md, not AGENTS.md: AGENTS.md is 12 bytes under its 26 KiB ceiling (backend/CLAUDE.md is 11 bytes under).

## Tried and ruled out
- Rendering Markdown in the browser: the website DOM-safety guard bans innerHTML, and static pages index better.
- Hiding the wiki's `---` before each ## with CSS `hr:has(+h2)`: the rule applies only after the heading parses, after the browser has already scrolled to the anchor, so deep links landed short. The generator now drops those rules instead.

## Watch out
- styles.css sets html{scroll-behavior:smooth}; docs pages override it (html.docs-root) or deep links animate down tens of thousands of pixels.
- The _redirects /docs -> wiki short link had to go, or it shadows the new pages.
- 20 screenshots the wiki referenced never existed; they render as "Screenshot pending" and the build lists them.

In the code: frontend/scripts/build-website-docs.mjs, frontend/scripts/website-docs/, frontend/src/test/website-docs.test.ts, website/docs/nav.json, website/README.md "Documentation" section.
