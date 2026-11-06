# Tasks: the help panel

Task list for `docs/future-plans/in-app-help-panel.md`. Needs plan 1 merged.
Check a box only when its gate passes and is quoted in the commit or PR.

## Decisions to confirm in review

- [x] The help panel and the assistant sheet share the right edge (opening one
      closes the other), or help docks left on wide screens.

## Frontend

- [x] `helpStore`: open, target, history, pinned (not persisted).
- [x] `HelpMarkdown`: toc-ordered heading ids, anchor targets, in-panel links,
      external links, image captions with an online link, callouts, tables.
- [x] `HelpPanel`: desktop sheet and phone bottom sheet, header controls, toc,
      section scroll in its own scroller, focus, Escape, route-change rule, pin,
      assistant collapse, unavailable and error states, English-only note.
- [x] Loaded through a dynamic import so the main bundle does not grow.
- [x] `PageHeader` `help?: DocsLink`; plain click opens the panel, modified
      click falls through; `helpUrl` removed.
- [x] Every page migrated from `helpUrl={docsUrl(x)}` to `help="x"`.
- [x] Settings > Help opens the panel at the landing page.
- [x] `help` namespace: English, pseudo-locale, then every locale.

## Tests

- [x] Renderer id parity with the generated website HTML, for every page.
- [x] `PageHeader`, `HelpPanel` and store unit tests listed in the plan.
- [x] Source scan: no `helpUrl=` and no docs URL literal under `src/app`.
- [x] E2E: `?` opens the panel in place; an internal link navigates inside it.

## Docs

- [x] User guide page describing the panel; affected screenshots retaken.
- [x] `docs/frontend/ui-conventions.md` entry and `frontend/CLAUDE.md` row.

## Verification

- [ ] Frontend gates green, quoted; bundle size unchanged on first load.
