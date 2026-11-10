---
title: Adding an existing file to a warranty copies it; trivia count sentences avoid plurals; the mobile + runs a page-registered action
author: Ken
date: 2026-11-10
branch: feat/ux-batch-nov10
id: l-3ba57380
scope: repo
status: active
src: agent
touches:
  - backend/src/attachments/warranty-attachment-copy.service.ts
  - frontend/src/store/mobileAddActionStore.ts
  - backend/src/ai/trivia/trivia-ledger.loader.ts
---

## Decided
- Attaching an already-uploaded file to a warranty is a server-side copy, not a re-link. An attachment has exactly one parent (WTY-003, chk_attachment_one_parent), so the copy goes through AttachmentsService.create (upload intent, parent lock, cap) and keeps a scan's original with it. The source stays where it was. Shared-group files are refused: they belong to the group.
- The mobile tab bar's + runs the page's own primary "new" action when the page registers one, and falls back to a new transaction otherwise. Each page calls useMobileAddAction(label, handler) with the same handler as its header button; a null label (read-only view) registers nothing.
- Trivia covers spending, income, records and warranties as well as net worth and investments. Money figures come from the built-in reports over the last twelve whole months in the reader's zone, and a fact is skipped when a report total did not fully convert. Warranty cover is read through warrantyStatus (WTY-002), never a date compare.

## Tried and ruled out
- ICU plurals in the calculated trivia sentences. The widget fills every figure in as a literal "{name}" string so it can highlight it, so plural selection never sees the number and "1 warranties" would show. Count facts are worded so the number stands alone ("Warranties ... still in cover: {warrantyCount}.").
- Copying the bytes client-side (download then re-upload) for the warranty copy. It loses the scan pair and moves up to 10 MB through the browser.

## Watch out
- With useMobileAddAction, a child's effect runs before its parent's, so a parent page that registers would override a child tab's action. The Shared Expenses page registers only on its Groups tab and leaves People to SharedPeople.
- A new trivia fact id or topic needs its catalog sentence in frontend en/dashboard.json; trivia-catalog.spec.ts fails otherwise, and also checks that each sentence quotes exactly its fact's figures.
- backend loan-payment-frequency.guard.spec.ts fails in a non-UTC local time zone, on main as well; run backend specs with TZ=UTC, as CI does.

In the code: backend/src/attachments/warranty-attachment-copy.service.ts (POST warranties/:warrantyId/attachments/copy), frontend/src/store/mobileAddActionStore.ts, backend/src/ai/trivia/trivia-ledger.loader.ts, trivia-ledger-facts.ts, trivia-catalog.spec.ts
