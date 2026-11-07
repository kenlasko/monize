# Tasks: help menu, tour and release-note links, version stamp, every-page guard

Task list for `docs/future-plans/in-app-help-extras.md`. Needs plan 2 merged
(plan 3 for the menu's search entry). Check a box only when its gate passes and
is quoted in the commit or PR.

## A. Help menu

- [x] Header `?` menu on the existing dropdown pattern; the same entries in
      `MobileNavDrawer`.
- [x] Keyboard shortcuts dialog.
- [x] Tests for entries and the hidden "Help for this page" case.

## B. Tours and the guide

- [x] `TourDefinition.docs?: DocsLink` and the last-step "Read the full guide".
- [x] `help-tours.ts` mapping and "Show me" in the panel.
- [x] Mapping test against `ALL_TOURS` and `DOCS_LINKS`.

## C. Guide links open in the panel

- [x] `isGuideUrl` against the manifest.
- [x] Link overrides in `ReleaseNotesMarkdown` and `AssistantMarkdown`.
- [x] Tests: recognised, unknown and lookalike URLs; modified clicks.

## D. Version stamp

- [x] Panel footer with the manifest version and the monize.net pointer.

## E. Every page offers help

- [x] `page-help.guard.test.ts` with reasoned exemptions and a self-test.
- [x] Pages the guide does not cover reported as documentation gaps: the
      guard's own run found every `PageHeader` missing `help` across the
      tree; all but one already had a matching guide page and got it
      (six new `DOCS_LINKS` destinations). The one gap is
      `src/app/share/page.tsx` (Web Share Target intake) -- no guide page
      describes it yet,
      recorded in the guard's `EXEMPTIONS` and here as a gap to write up,
      not a permanent exemption.

## Docs and copy

- [x] `help` namespace additions: English, pseudo-locale, every locale.
- [x] Guide page for the Help menu (getting-started.md, docs:build). Header
      screenshots **not** retaken: the e2e Docker stack's backend `nest
      build` step OOMs on this machine's shared memory limit even before
      Playwright starts (tried once, torn down -- see the PR description).
      `images/navigation-bar.png` needs a retake once that is run somewhere
      with more headroom; it is not pixel-wrong, just stale (missing the new
      `?` icon).
- [x] `docs/frontend/ui-conventions.md` entries.

## Verification

- [x] Frontend gates green, quoted (lint, type-check, i18n:check,
      test:changed -- 906 files / 16839 tests, build). Header E2E specs
      **not run**: same Docker memory ceiling as the screenshots above.
