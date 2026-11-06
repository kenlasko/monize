# Plan: in-app help (overview)

The user guide is published only at www.monize.net/docs. The app links to it,
but every link opens a new browser tab, and an instance that is offline or a
version behind gets help that does not match it. This overview ties together
six plans that bring the guide into the app. Each plan stands on its own and is
executed from its own file. Read this file first for the decisions they share.

## Assumptions (verified against the tree, 2026-11)

- The guide is Markdown in `website/docs/` (one file per page, order and groups
  in `website/docs/nav.json`). `frontend/scripts/build-website-docs.mjs` renders it
  into the static site and writes `website/docs/search-index.json`, one entry
  per h2/h3 section (`u` URL with anchor, `p` page title, `h` heading, `x` plain
  text). `npm run docs:check` (run by `frontend/src/test/website-docs.test.ts`)
  fails when a generated file is stale.
- The app reaches the guide in two places, both opening a new tab: the `?`
  icon in `PageHeader` (`helpUrl={docsUrl(key)}`, on about 30 pages) and
  Settings > Help (`frontend/src/components/settings/HelpSection.tsx`). Every
  destination is a key in `frontend/src/lib/docs-links.ts`; `docs-links.test.ts`
  fails when a page or anchor a key names is gone.
- The app's CSP (`frontend/src/proxy.ts`) is `connect-src 'self'` and
  `img-src 'self' data: blob:`. Anything the app reads has to come from its own
  origin.
- The frontend image is built with `./frontend` as its Docker context, so it
  cannot see `website/`. The backend image is built from the repository root and
  already copies `docs/release-notes` into itself so `ReleaseNotesService`
  (`backend/src/updates/release-notes.service.ts`) can serve What's New offline.
  That service and its public `ReleaseNotesController` are the precedent this
  work follows.
- The guide is English only. The app ships about 20 locales.
- Markdown rendering already exists in the app (`ReleaseNotesMarkdown.tsx`,
  `AssistantMarkdown.tsx`, both `react-markdown` + `remark-gfm`), as do
  `InfoTooltip`, `EmptyState`, guided tours (`frontend/src/lib/tours/`) and
  the shared AI tool framework (assistant executor plus MCP tools, wired together
  per `docs/backend/ai-and-payees.md`, "Shared AI tools").

## Decisions shared by every plan

1. **The guide ships inside each release and is served by the backend.** The
   backend image copies `website/docs` (Markdown, `nav.json`,
   `search-index.json`; no images) exactly as it copies the release notes, and a
   new public, read-only help API serves it. Help therefore matches the running
   version, works on an internet-isolated instance and needs no CSP change.
   Rejected: committing a second generated copy into `frontend/` (duplicates
   ~0.7 MB that must be kept in step, and the backend would still need its own
   copy for the assistant); fetching from monize.net (CSP change, version drift,
   fails offline).
2. **Text only.** Screenshots (31 MB) are not bundled. Where a page shows a
   picture, the app shows its caption and a link to the same section on
   monize.net. Revisit once the panel exists.
3. **One search, on the server.** The help panel's search, the command search
   and the assistant tool all call the same backend scorer, so they cannot rank
   differently and no client-side search dependency is added.
4. **A destination is still a `docs-links.ts` key.** Every new entry point (panel,
   tooltip link, empty state, tour step, citation) names a key, never a URL, so
   the existing anchor check keeps covering all of them.
5. **English content inside translated chrome.** Every control around the help
   text is translated as usual; the content is English, and a reader whose
   locale is not English sees one translated line saying so.
6. **A slug is looked up, never joined into a path.** The API serves only pages
   named in `nav.json`; anything else is a 404. This is the same rule the website
   applies to screenshot names (`website/README.md`).

## The plans, in the order to build them

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | `docs/future-plans/in-app-help-bundled-docs.md` | the help API and client; no UI | nothing |
| 2 | `docs/future-plans/in-app-help-panel.md` | the `?` icon opens a side panel in the app | 1 |
| 3 | `docs/future-plans/in-app-help-search.md` | `Ctrl/Cmd+K` help search from any screen | 1, 2 |
| 4 | `docs/future-plans/in-app-help-extras.md` | header Help menu, tour and What's New links, version stamp, every-page guard | 2 (3 for the menu's search entry) |
| 5 | `docs/future-plans/in-app-help-contextual-links.md` | "Learn more" on tooltips, empty states and error messages | 2 |
| 6 | `docs/future-plans/in-app-help-assistant-tool.md` | the assistant and MCP answer usage questions from the guide | 1 (2 for clickable citations) |

Plan 2 alone delivers most of the "seamless" effect; plan 5 is ongoing
editorial work that can run alongside anything after it.

## Open decisions (owner)

- Screenshots: stay text only, ship one theme as compressed WebP (estimated
  5-8 MB in the backend image), or ship all.
- Whether help search later grows into a full command palette (pages and
  actions as well as help). Plan 3 leaves room for it and does not build it.
- Whether the help API is public (usable on the login and 2FA screens, like the
  release notes) or behind `AuthGuard('jwt')`. Plan 1 recommends public.

## What every plan runs before pushing

The layer gates in `AGENTS.md` ("Required before you push") for each layer it
touches, plus `npm run docs:check` in `frontend/` whenever `website/docs/`
changes, and `node scripts/check-docs-manifests.mjs` from the root for any doc
that names a path or an npm script. Stage new files before running the
tree-walking guards.
