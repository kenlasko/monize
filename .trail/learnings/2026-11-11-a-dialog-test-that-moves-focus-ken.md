---
title: "A dialog test that moves focus must wait a frame, and the unsaved-changes prompt has no accessible name"
author: Ken
date: 2026-11-11
branch: fix/receipt-search-widths-profile-validation
id: l-ac1358ca
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/email-receipts/ParserEditorDialog.test.tsx
  - frontend/src/components/email-receipts/ParserEditorDialog.tsx
  - frontend/src/components/email-receipts/ParserPatternFields.tsx
  - frontend/src/components/email-receipts/ReceiptSearchBar.tsx
  - frontend/src/i18n/messages/de/emailReceipts.json
  - frontend/src/i18n/messages/en/emailReceipts.json
  - frontend/src/i18n/messages/es/emailReceipts.json
  - frontend/src/i18n/messages/fr/emailReceipts.json
  - frontend/src/i18n/messages/hi/emailReceipts.json
  - frontend/src/i18n/messages/id/emailReceipts.json
---

## Decided
Tests that check where focus lands in a Modal first wait one animation frame after rendering. Modal moves focus to its first control on the next frame, so a Save clicked straight after render had its focus taken back. A test passed on its own and failed in the full file, purely from timing. Real users cannot click within one frame, so the component was left as it is.

The email-receipt profile editor asks before it closes with unsaved edits by reusing UnsavedChangesDialog through Modal's onBeforeClose, which covers the backdrop, Escape and Back, and through its own Cancel. "Unsaved" means what a save would send has changed, so a Form/JSON switch or an edit that was typed and then removed closes without asking.

## Tried and ruled out
- Finding the prompt with getByRole('dialog', { name: 'Unsaved Changes' }): UnsavedChangesDialog draws its own h3 and does not pass Modal a title, so the dialog has no accessible name. Find it by its heading text plus closest('[role="dialog"]').
- Marking "unsaved" by comparing the raw form state: switching to JSON and back rewrites the JSON text, so the editor looked changed when nothing was.

## Watch out
- A focus assertion that passes alone and fails in the full file usually means Modal's focus frame landed after the test's action.
- A screen.queryByText(...)?.closest(...) helper returns undefined, not null, when nothing matches. Add `?? null` before using toBeNull.

In the code:
- frontend/src/components/ui/Modal.tsx: the "Auto-focus first focusable element on open" effect, which focuses inside requestAnimationFrame
- frontend/src/components/email-receipts/ParserEditorDialog.test.tsx: renderEditor awaits requestAnimationFrame; the unsavedPrompt() helper
- frontend/src/components/email-receipts/ParserEditorDialog.tsx: requestClose, and the snapshot made with buildParserPayload
