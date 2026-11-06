# Plan: help search from any screen (in-app help, plan 3)

Part of `docs/future-plans/in-app-help.md`; needs plan 1's help API and plan 2's
panel. `Ctrl/Cmd+K`, or `?` outside a text field, opens a search over the guide
from any screen. Results rank the current screen's page first and open in the
help panel. One PR: backend scorer and endpoint, frontend dialog.

## Assumptions (verified against the tree, 2026-11)

- Plan 1 bundles `search-index.json` (one entry per h2/h3 section: URL with
  anchor, page title, heading, plain text) into the backend image, and
  `HelpService` loads it once.
- Plan 2's `helpStore` knows the panel's state. `PageHeader` knows each screen's
  `help` key.
- There is no app-wide keyboard shortcut today. The only key handlers are local
  (`DateInput`'s field shortcuts, Escape in `AiChatBubble`), so `Ctrl/Cmd+K`
  and `?` are free. `?` must never fire while focus is in an input, a textarea,
  a select or a contenteditable.
- About 500 sections in total. A plain scorer answers in well under a
  millisecond, so no search library or index build is needed. That keeps the
  "adding a dependency" question closed.

## Design

### Backend: one scorer, used by every search

`backend/src/help/help-search.ts`, a pure function over the loaded index, and
`HelpService.search(query, { contextPage, limit })`:

- Normalise: lower case, Unicode NFKD with combining marks removed, split on
  non-letter/digit. Drop a short stop-word list. The last token matches as a
  prefix, so results appear while the reader is still typing.
- Score per section: a heading match counts more than a page-title match, which
  counts more than a body match; all tokens matching beats some. A section of
  `contextPage` gets a fixed boost, enough to lead among comparable matches but
  never enough to outrank a heading match elsewhere.
- A small synonym table, written once in the same file, covers the guide's
  vocabulary gaps: chequing/checking, recurring/scheduled/bills,
  stock/security/holding, split/splits, import/upload, 2FA/two-factor/TOTP. It
  can grow when a real query misses.
- Answer `{ results: [{ page, section, pageTitle, heading, excerpt, score }],
  total }`. `excerpt` is plain text around the first body match (about 160
  characters), never HTML. The client highlights the query tokens itself.

`GET /help/search?q=&context=&limit=` on `HelpController`, public like the rest
of the help API. `q` is required and at most 200 characters after trimming.
`context` must be a page slug from the manifest or absent. `limit` is 1-20,
default 10. DTO with `whitelist` + `forbidNonWhitelisted`; the throttler applies.

### Frontend: the search dialog

- `frontend/src/components/help/HelpSearchDialog.tsx`, built on `Modal` with a
  title, mounted once beside the panel. A search field, the result list, and a
  footer with the key hints.
- Opened by `Ctrl/Cmd+K` anywhere and `?` outside an editable element (one
  listener in the shell, behind an `isEditableTarget` helper). It is also opened
  by the panel's own search field and, in plan 4, the header Help menu.
- Context: `PageHeader` registers its `help` key in `helpStore` while mounted,
  so the dialog knows the current screen without a route table. With an empty
  query it shows "Help for this screen" (that page's toc), so `?` followed by an
  arrow key is already useful.
- Typing debounces about 150 ms. Each response is kept with the query that
  produced it, and an older response never replaces a newer one
  (`docs/frontend/api-and-cache.md`). A failed request shows an error, never
  "no results".
- Arrow keys move, Enter opens the panel at that section, Escape closes. The
  result list is a listbox with `aria-activedescendant`.
- Room for later: the result model has a `kind` (only `help` for now), so pages
  and actions can join the same list if the owner approves a full command
  palette. Nothing in this plan builds that.

### Copy

Extend the `help` namespace: placeholder, "Help for this screen", "No results
for {query}", the error, the key hints. English first, pseudo-locale, every
locale last.

## Tests

- Scorer unit tests: heading over body, all-tokens over some, prefix on the last
  token, accents ignored, synonyms, the context boost never beating a heading
  match elsewhere, stable order on ties, excerpt bounds, no HTML in output.
- A fixture of real questions with the section each must return in its top
  three ("how do I split a transaction", "change my default currency", "restore
  a backup", "add a mortgage", "two-factor"). This doubles as the assistant
  tool's quality check in plan 6.
- Controller spec: validation bounds, unknown `context` ignored or refused (pick
  one and pin it), public access.
- Dialog tests: both shortcuts, `?` ignored inside inputs, empty-query context
  list, stale responses discarded, keyboard navigation, Enter opens the panel at
  the section, error state.
- E2E: on Transactions, `?` then Enter opens a Transactions section; typing
  "backup" and Enter opens Backup and restore.

## Docs

- The guide's landing page and getting-started mention `Ctrl/Cmd+K` and `?`.
- `docs/frontend/ui-conventions.md`: the global shortcuts and the
  `isEditableTarget` rule, so a later shortcut does not hijack typing.

## What to run

`backend/` and `frontend/` gates per `AGENTS.md`; the new E2E spec on its own.

## Observable when done

Pressing `?` on the Budgets page lists the Budgets sections at once. Typing "fx
rate" lists the currency sections first, and Enter opens one in the panel.
Typing `?` into a payee field types a question mark.
