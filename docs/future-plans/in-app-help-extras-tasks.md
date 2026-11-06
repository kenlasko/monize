# Tasks: help menu, tour and release-note links, version stamp, every-page guard

Task list for `docs/future-plans/in-app-help-extras.md`. Needs plan 2 merged
(plan 3 for the menu's search entry). Check a box only when its gate passes and
is quoted in the commit or PR.

## A. Help menu

- [ ] Header `?` menu on the existing dropdown pattern; the same entries in
      `MobileNavDrawer`.
- [ ] Keyboard shortcuts dialog.
- [ ] Tests for entries and the hidden "Help for this page" case.

## B. Tours and the guide

- [ ] `TourDefinition.docs?: DocsLink` and the last-step "Read the full guide".
- [ ] `help-tours.ts` mapping and "Show me" in the panel.
- [ ] Mapping test against `ALL_TOURS` and `DOCS_LINKS`.

## C. Guide links open in the panel

- [ ] `isGuideUrl` against the manifest.
- [ ] Link overrides in `ReleaseNotesMarkdown` and `AssistantMarkdown`.
- [ ] Tests: recognised, unknown and lookalike URLs; modified clicks.

## D. Version stamp

- [ ] Panel footer with the manifest version and the monize.net pointer.

## E. Every page offers help

- [ ] `page-help.guard.test.ts` with reasoned exemptions and a self-test.
- [ ] Pages the guide does not cover reported as documentation gaps.

## Docs and copy

- [ ] `help` namespace additions: English, pseudo-locale, every locale.
- [ ] Guide page for the Help menu; header screenshots retaken.
- [ ] `docs/frontend/ui-conventions.md` entries.

## Verification

- [ ] Frontend gates green, quoted; header E2E specs pass.
