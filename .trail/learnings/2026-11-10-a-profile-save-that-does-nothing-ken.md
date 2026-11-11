---
title: "A profile Save that does nothing was a hidden server error, not HTTP, the proxy or missing AI"
author: Ken
date: 2026-11-10
branch: fix/receipt-profile-save-errors
id: l-21afe774
scope: repo
status: active
src: agent
touches:
  - frontend/src/lib/errors.ts
  - frontend/src/components/email-receipts/ParserEditorDialog.tsx
  - frontend/src/lib/receipt-parser-form.ts
  - backend/src/email-receipts/parsers/dto/receipt-domain.validator.ts
---

## Decided
"Save does nothing" in the email-receipt profile editor (discussion #2109) was a 400 the editor failed to show. The server refused a sender domain typed as a full address. Validation (DTO) refusals send `message` as a list of sentences, and the editor's error parsing threw on the list inside its catch, so no error appeared. getErrorMessage now always returns a string, and a pasted address keeps only its domain, both in the form and on the server.

## Tried and ruled out
- crypto.randomUUID over plain HTTP (#2077): the reporter was on a beta that has that fix and reached Monize over HTTPS.
- Reverse proxy (Synology), CSRF or CORS settings: the request reached the backend and got a normal 400.
- No AI provider: saving a profile written by hand never calls AI. Only the profile wizard needs it, and it says so.
- Backend logs: a 400 refused at validation logs nothing, so "no errors in the logs" proves nothing here.

## Watch out
- Any error message read from a NestJS response can be a string[]. Use getErrorMessage, or join the list yourself, before calling string methods on it.
- The editor's Test panel does not check From domains, so a profile can test fine and still be refused on Save.
- The quickest diagnosis for a silent Save is the browser's Network tab (the response body) plus the Console error.

In the code:
- frontend/src/lib/errors.ts getErrorMessage (joins a list message)
- frontend/src/components/email-receipts/ParserEditorDialog.tsx handleSave -> parseValidationProblems (threw `message.matchAll is not a function`)
- frontend/src/lib/receipt-parser-form.ts splitDomains, backend/src/email-receipts/parsers/dto/receipt-domain.validator.ts normalizeReceiptDomain (drop up to the last `@`)
