---
title: Every transaction and security form dialog takes its size from one shared props object
author: Ken
date: 2026-11-06
branch: feat/us-treasury-bonds
cost: { minutes: 20, tokens: 108582 }
id: l-23915d0c
scope: repo
status: active
src: agent
touches:
  - backend/test/integration/us-treasury-flow.integration.spec.ts
  - frontend/src/components/transactions/transaction-modal.ts
  - frontend/src/components/investments/investment-transaction-modal.ts
  - frontend/src/components/securities/security-form-modal.ts
  - frontend/src/components/form-modal-size.guard.test.ts
---

## Decided
- Ken asked that every surface opening New/Edit Transaction match the Transactions page exactly, and that New Security opened from the investment form match the Securities page. Rather than fixing the two narrow hosts (Payee and Category detail tabs at 2xl, investment form's New Security at lg), each form's Modal size now lives in one props object that every host spreads, with a source-scanning guard.
- The headings that were hand-rolled `<h2>`s on those hosts moved to Modal's `title` prop (same look, plus aria-labelledby).
- A security's detail page Transactions tab now widens its Edit modal while the investment form asks for a currency conversion, as the Investments page and the account register already did.

## Watch out
- The guard fails a host that spreads the shared props and then also passes `maxWidth` or `className` on the same Modal. A dialog that really needs a different width needs its own form props, not an override.
- Moving a hand-rolled heading onto `title` takes that file off the shrink-only baseline in ui-conventions.test.ts ("a dialog is titled through Modal"). That test fails until the entry is removed.

In the code:
- frontend/src/components/transactions/transaction-modal.ts (`transactionModalProps`: 6xl + p-6 !max-w-[69rem])
- frontend/src/components/investments/investment-transaction-modal.ts (`investmentTransactionModalProps(needsConversion)`, replaces `investmentTransactionModalClass`)
- frontend/src/components/securities/security-form-modal.ts (`securityFormModalProps`: 3xl + p-6)
- frontend/src/components/form-modal-size.guard.test.ts
