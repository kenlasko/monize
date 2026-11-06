# Plan: help menu, tour and release-note links, version stamp, every-page guard (in-app help, plan 4)

Part of `docs/future-plans/in-app-help.md`. Five small pieces that make the help
panel (plan 2) and search (plan 3) easy to find and keep them complete. Each
piece is its own commit; together they fit one PR, or split them if review
prefers.

## Assumptions (verified against the tree, 2026-11)

- `AppHeader` (`frontend/src/components/layout/AppHeader.tsx`) holds the
  top-bar controls; its link tests (`AppHeader.*-link.test.tsx`) show how a new
  entry is pinned.
- Tours are registered in `frontend/src/lib/tours/registry.ts` (`ALL_TOURS`,
  `getTourById`, `INTRO_TOUR`) with types in `frontend/src/lib/tours/types.ts`,
  and are started through `useTourStore`.
- What's New renders release-note Markdown with
  `frontend/src/components/whats-new/ReleaseNotesMarkdown.tsx`; the assistant
  renders answers with `AssistantMarkdown.tsx`.
- Plan 1's manifest carries the running version.

## Pieces

### A. Help menu in the app header

A `?` button beside the avatar opens a menu:

- Help for this page (the current `PageHeader` `help` key, from `helpStore`;
  hidden when the page has none)
- Search help (`Ctrl/Cmd+K`)
- Keyboard shortcuts (a small dialog listing the global shortcuts from plan 3
  and Escape)
- Take the tour (the current page's tour, when piece B maps one; otherwise the
  intro tour)
- What's new
- Report an issue, Discussions (the links `HelpSection` already has, from
  `frontend/src/lib/github.ts`)

On phones the same entries go in `MobileNavDrawer`, not behind a hover. The
menu reuses the app's existing dropdown pattern. Search for the account menu's
component before writing one.

### B. Tours and the guide point at each other

- `TourDefinition` gains an optional `docs?: DocsLink`. A tour that has one ends
  with a "Read the full guide" action that opens the panel there.
- `frontend/src/lib/help-tours.ts`: `Partial<Record<DocsLink, string>>` from a
  guide destination to a tour id. The panel shows "Show me" on a page that has
  one, and starts the tour (closing the panel first). A test fails when a mapped
  tour id is not in `ALL_TOURS`, or a tour's `docs` key is not in `DOCS_LINKS`.

### C. Guide links in release notes and assistant answers open in the panel

One shared helper, `isGuideUrl(href)`, recognises `https://www.monize.net/docs/...`
and maps it to `{ page, section }` against the manifest. `ReleaseNotesMarkdown`
and `AssistantMarkdown` override their link component to open the panel for a
recognised URL on a plain click. Any other URL behaves as now. Release-note
authors keep writing ordinary website links, and plan 6's citations use the
same path.

### D. Version stamp

The panel footer reads "Guide for Monize {version}" from the manifest, plus "The
latest guide is on monize.net". This makes it clear that the website can
describe newer features than the instance has.

### E. Every page offers help

A source-scanning test (`frontend/src/app/page-help.guard.test.ts`) fails when a
page under `frontend/src/app` renders `PageHeader` without `help`. Its
exemptions (login, OAuth consent, error pages, any screen the guide does not
cover) are a constant in the test, each with its reason. As a new allowlist it
is reviewed in the PR, and it is shrink-only from then on (`AGENTS.md`). A
screen the guide does not cover is a documentation gap to report, not a
permanent exemption.

## Tests

- `AppHeader` menu: entries, "Help for this page" hidden without a key, phone
  drawer entries.
- Tours: the mapping test in B; the last-step action opens the panel; "Show me"
  closes the panel and starts the tour.
- `isGuideUrl`: website URLs with and without a section, the landing page, an
  unknown page (falls through to the browser), a lookalike host (falls through).
- Renderers: a guide link opens the panel on plain click and is left alone on a
  modified click.
- The guard in E, plus a self-test that it catches a fixture page without `help`.

## Docs

- The guide's getting-started page describes the Help menu. Retake the header
  screenshots that show the new button.
- `docs/frontend/ui-conventions.md`: "a link to the guide in rendered Markdown
  opens the panel through `isGuideUrl`", and the page-help guard.

## What to run

`frontend/` gates per `AGENTS.md`. Grep `e2e/` for the header's accessible names
before adding the button; run any header-driving spec.

## Observable when done

The header's `?` offers help for the current page, search, the tour and What's
New. A guide link in What's New opens beside the notes. A new page added without
`help` fails CI with its path named.
