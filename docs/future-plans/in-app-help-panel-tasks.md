# Tasks: the help panel

Task list for `docs/future-plans/in-app-help-panel.md`. Needs plan 1 merged.
Check a box only when its gate passes and is quoted in the commit or PR.

## Decisions to confirm in review

- [ ] The help panel and the assistant sheet share the right edge (opening one
      closes the other), or help docks left on wide screens.

## Frontend

- [ ] `helpStore`: open, target, history, pinned (not persisted).
- [ ] `HelpMarkdown`: toc-ordered heading ids, anchor targets, in-panel links,
      external links, image captions with an online link, callouts, tables.
- [ ] `HelpPanel`: desktop sheet and phone bottom sheet, header controls, toc,
      section scroll in its own scroller, focus, Escape, route-change rule, pin,
      assistant collapse, unavailable and error states, English-only note.
- [ ] Loaded through a dynamic import so the main bundle does not grow.
- [ ] `PageHeader` `help?: DocsLink`; plain click opens the panel, modified
      click falls through; `helpUrl` removed.
- [ ] Every page migrated from `helpUrl={docsUrl(x)}` to `help="x"`.
- [ ] Settings > Help opens the panel at the landing page.
- [ ] `help` namespace: English, pseudo-locale, then every locale.

## Tests

- [ ] Renderer id parity with the generated website HTML, for every page.
- [ ] `PageHeader`, `HelpPanel` and store unit tests listed in the plan.
- [ ] Source scan: no `helpUrl=` and no docs URL literal under `src/app`.
- [ ] E2E: `?` opens the panel in place; an internal link navigates inside it.

## Docs

- [ ] User guide page describing the panel; affected screenshots retaken.
- [ ] `docs/frontend/ui-conventions.md` entry and `frontend/CLAUDE.md` row.

## Verification

- [ ] Frontend gates green, quoted; bundle size unchanged on first load.
