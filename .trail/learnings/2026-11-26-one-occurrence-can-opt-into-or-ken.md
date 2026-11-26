---
title: One occurrence can opt into or out of auto-posting; an estimated one only once its own amount is entered
author: Ken
date: 2026-11-26
branch: fix/autopost-tooltip-overflow
cost: { minutes: 32, tokens: 211349 }
id: l-e50e90fd
scope: repo
status: active
src: agent
touches:
  - backend/src/scheduled-transactions/occurrence-auto-post.ts
  - backend/src/scheduled-transactions/occurrence-auto-post.spec.ts
  - backend/test/integration/scheduled-occurrence-auto-post.integration.spec.ts
  - database/migrations/20261126032000_scheduled_overrides_auto_post.sql
  - e2e/docs-screenshots/capture.ts
  - frontend/src/components/ui/Card.tsx
  - website/docs/images/bills-edit-occurrence.png
  - website/docs/images/bills-deposits-page.png
  - website/docs/images/bills-list.png
---

## Decided
- The occurrence override carries a nullable `auto_post`: NULL follows the schedule, TRUE posts that one occurrence automatically, FALSE leaves it for a person (Ken chose "both ways").
- An estimated schedule's occurrence auto-posts only when its override opts in explicitly AND states its amount (not following the estimate). A legacy `auto_post = true` on an estimated schedule row does not count as opting in.
- The dialog saves the occurrence's choice only when it differs from what the schedule does (otherwise NULL), so a later schedule change still reaches it.
- A tooltip next to a control inside a Modal uses `InfoTooltip usePortal` (with `placement="top"` near the footer); the inline popover is clipped by the modal.
- `cardOf` (the doc-capture helper that crops a picture to the card around an element) matches the `ui-card` marker class that `CARD_CLASS` carries, not a corner class.

## Watch out
- The cron, the under-lock `requireActiveAutoPost` check and the posting undo's `wouldAutoPost` must all use the same rule; a drift re-posts or skips. The TS rule and its SQL twin live side by side.
- Reminders (`manualOnly`) still filter on the schedule's `auto_post`, so an opted-out occurrence of an auto-posting schedule gets no reminder, and an opted-in one still does.

In the code: backend/src/scheduled-transactions/occurrence-auto-post.ts (`occurrenceAutoPosts`, `OCCURRENCE_AUTO_POSTS_SQL`, `assertOverrideAutoPostAllowed`); cron in `processAutoPostWithinContext` (`findAutoPostOptOutIds` for the by-date path, the SQL predicate on the override path); migration database/migrations/20261126032000_scheduled_overrides_auto_post.sql; frontend OverrideEditorDialog.tsx (`autoPostChoice`, `autoPostLocked`).
- A timeout on `scrollIntoViewIfNeeded` of a `cardOf(...)` locator in a docs-screenshot run means the locator matches nothing, not that the dev server is slow.

In the code: e2e/docs-screenshots/capture.ts (`cardOf`), frontend/src/components/ui/Card.tsx (`CARD_CLASS`).

## Tried and ruled out
- The old `rounded-lg` ancestor lookup: since the Classic/Modern UI styles, a card's radius is the token `rounded-(--ui-radius-card)`, so the lookup matched nothing and every picture cropped to a card timed out at 300s with "Target page, context or browser has been closed". 14 spec files call it, so their card-cropped pictures had silently stopped refreshing.
