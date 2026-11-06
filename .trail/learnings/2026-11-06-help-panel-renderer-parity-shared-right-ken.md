---
title: "Help panel: renderer parity, shared right edge, and test/e2e traps"
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-3610246e
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/help/HelpPanel.tsx
  - frontend/src/components/help/HelpMarkdown.tsx
  - frontend/src/lib/markdown/remark-help.ts
  - frontend/src/lib/help-open.ts
  - frontend/src/store/helpStore.ts
  - frontend/src/components/ai/AiChatBubble.tsx
  - frontend/src/components/layout/SwipeShell.tsx
  - e2e/tests/help-panel.spec.ts
---

## Decided
- The help panel and the assistant share the right edge through the help store: AiChatBubble watches `helpStore.open` (collapses to closed, render-phase setState like its route rule) and its launcher calls `helpStore.close()`. No new event or second store.
- A docked panel pushes the page aside on `xl` (`xl:pr-[420px]` on the SwipeShell root) so "the budget still on screen" is literally true; below `xl` it overlays, as the assistant does. The width literal in SwipeShell is pinned to `HELP_PANEL_WIDTH` by a SwipeShell test, because Tailwind needs the literal class.
- The `?` click goes through `openHelp(key)`: manifest `available` plus a `getPage` preflight, else `window.open` of the website. The preflight reads are the ones the panel makes next (deduped), so they cost nothing extra.
- HelpMarkdown ids: `##`/`###` take the page's `toc` ids in order, deeper headings are slugged with the same duplicate counter the website uses, so the parity test compares every `[id]` of the rendered page with the generated `website/docs/<page>.html`.
- The panel's Escape and Tab handling ignore a keydown whose focus sits in another `[role="dialog"]`, so a form opened over the page keeps its own Escape.

## Tried and ruled out
- `scrollIntoView` for the section jump: it scrolls every ancestor and moves the page behind the panel. The panel sets its own scroller's `scrollTop` and looks the section up inside the scroller (not `getElementById`, the page behind can carry the same id).
- Reading ids from the generated HTML naively in the parity test: the template adds ids before the content (header, sidebar), after it (`search`, `q`, `sres`, `shint`), and on the landing page one per nav group card. The test slices between `id="content"` and `id="search"` and drops the nav group slugs for `index`.
- Running Playwright on the host: the chromium build lacks libglib. Use `scripts/e2e-playwright.sh npx playwright test ...` (the pinned image is already local after one CI-style pull); the e2e stack itself comes up with `docker compose -f docker-compose.e2e.yml up -d --build --wait` and its dev backend image already carries `./help`.

## Watch out
- Vitest keeps a persistent transform cache in `frontend/node_modules/.vitest-cache`. `src/test/render.tsx` globs `i18n/messages/en/*.json`, and the cached transform keeps the old file list, so a brand-new namespace renders as raw keys and fails with "Could not resolve help.markdown". Delete `node_modules/.vitest-cache` (and `node_modules/.vite/vitest`) after adding a namespace file.
- Opening help from a pinned panel on a sign-in route: the panel is not mounted on auth routes, so SwipeShell closes the help store there; otherwise a pinned panel reappears after the next sign-in.

In the code:
- frontend/src/components/help/HelpPanel.tsx, HelpPanelLoader.tsx (dynamic import)
- frontend/src/components/help/HelpMarkdown.test.tsx (parity with generated HTML)
- frontend/src/test/help-links.guard.test.ts (no `helpUrl=`, no docs URL literal under src/app)
