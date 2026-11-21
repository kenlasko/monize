---
title: "A renamed KMyMoney name is kept in notes or description within the edit form's bound; cuts are numbered"
author: Node
date: 2026-11-21
branch: claude/issue-2313
cost: { minutes: 19, tokens: 136769 }
touches:
  - e2e/docs-screenshots/importing-from-kmymoney.spec.ts
  - frontend/src/i18n/messages/de/import.json
  - frontend/src/i18n/messages/en/import.json
  - frontend/src/i18n/messages/es/import.json
  - frontend/src/i18n/messages/fr/import.json
  - frontend/src/i18n/messages/hi/import.json
  - frontend/src/i18n/messages/id/import.json
  - frontend/src/i18n/messages/it/import.json
  - frontend/src/i18n/messages/ja/import.json
  - frontend/src/i18n/messages/ko/import.json
---

## Decided
- Review of #2313: a name replaced for being too long keeps its whole text. A payee writes it to `notes`, an account (or investment pair) to `description`, after the file's own text and a blank line (`appendOriginal`, kmy-name-fixes.ts), and the raw element carries it as `originalName`.
- The bound stays at 500, the payee and account DTOs' MaxLength, so the row still saves from its edit form. Past it the start is kept and the new `originalNameCut` warning names the row. Lifting the cap was declined: the payee form resends notes, so a longer note fails every later save with a 400.
- Default cuts never land on a name their kind already holds (names that fit, user renames, earlier cuts, ignoring case); they become "<cut> (2)", " (3)". A user's rename is taken as given, so naming two alike merges them on purpose.
- KMyMoney "match on name" / "exact name" rules translate from `originalName`, never the rename, so a rename cannot invent `*Stadtwerke*`.

## Tried and ruled out
- Putting the original into each transaction's description: it rewrites every row's memo, and a schedule's description is copied onto every posted occurrence.

## Watch out
- The name DTOs cap payee, account, category, schedule and tag names at 100 characters, but the columns (and this importer, and the Money importer) allow 255. An imported name of 101 to 255 characters cannot be saved unchanged from its edit form. This is an existing mismatch, reported rather than fixed here.
- Docs screenshot recipe still holds with the v1.65.0 Playwright image: ports reset, backend heap 4096, a TCP proxy localhost:3001 -> frontend:3000 inside the Playwright container. Upload an in-memory file with setInputFiles({name, mimeType, buffer}) rather than committing a new fixture.
