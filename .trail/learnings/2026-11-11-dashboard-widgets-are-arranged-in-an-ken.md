---
title: "Dashboard widgets are arranged in an edit mode on the dashboard, sized by width and height presets, and the hero stays fixed"
author: Ken
date: 2026-11-11
branch: fix/receipt-search-widths-profile-validation
id: l-cb5fb877
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/dashboard-edit-mode-tasks.md
  - docs/future-plans/dashboard-edit-mode.md
  - frontend/src/components/email-receipts/ParserEditorDialog.test.tsx
  - frontend/src/components/email-receipts/ParserEditorDialog.tsx
  - frontend/src/components/email-receipts/ParserPatternFields.tsx
  - frontend/src/components/email-receipts/ReceiptSearchBar.tsx
  - frontend/src/i18n/messages/de/emailReceipts.json
  - frontend/src/i18n/messages/en/emailReceipts.json
  - frontend/src/i18n/messages/es/emailReceipts.json
  - frontend/src/i18n/messages/fr/emailReceipts.json
---

## Decided
- Ken chose (2026-11-10): resize means a width preset plus a height preset, with widgets flowing in stored order; an edit mode entered from the Customize gear, nothing stored until Done, Cancel restores; on a phone edit mode offers add, remove and reorder only; the Customize dialog shrinks to the hero's settings. The hero is never movable, resizable or removable.
- Proposed defaults still awaiting Ken: thirds and halves on 12 columns; sizes stored beside each widget's settings so the feature needs no migration or DTO change; a height is a floor, never a clip; pointer-based reorder written on the existing drag handle, no new dependency.

## Tried and ruled out
- Free-form x/y grid (Grafana style): needs a grid-layout dependency, a layout per breakpoint, and every widget rendering at arbitrary sizes.
- Width only: Ken wanted height too.
- Auto-save per change, and always-on handles with no mode: Ken wanted Done/Cancel.
- Keeping the old dialog as a second way to arrange widgets: one place only.
- HTML5 drag for moving: it does not fire on touch.
- Quarter widths on 4 columns: 214px at a 1024px viewport, too narrow for any current widget.
- `grid-auto-flow: dense` to fill row-end gaps: shows widgets out of stored and tab order.
- A new layout column: two sources of truth with the ordered id list the trivia service reads.

## Watch out
- A row can end short when the next widget does not fit; that is intended.
- Four widgets with a 500px floor fold into the 540px preset, growing the Net Worth row by 40px in the default layout; Ken has not yet accepted this.
- The card must fill its grid item by grid stretch, never a percentage height (the WebKit row-sizing defect, issue 1382).

In the code:
- Plan pair: docs/future-plans/dashboard-edit-mode.md and dashboard-edit-mode-tasks.md (proposal, tasks F1-F6, uncommitted at time of writing).
- Size keys: `gridWidth`, `gridHeight` in `dashboardWidgetConfig[widgetId]`; bounds in backend/src/users/validators/is-dashboard-widget-config.validator.ts.
- Reused: frontend/src/components/ui/DragHandle.tsx, UnsavedChangesDialog.tsx.
