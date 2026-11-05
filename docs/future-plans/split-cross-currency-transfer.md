# Plan: cross-currency transfer lines in a split

Executes [`docs/specs/split-cross-currency-transfer.md`](../specs/split-cross-currency-transfer.md);
read the spec first. This plan says what to edit, what to run and what to
observe. The task list is
[`split-cross-currency-transfer-tasks.md`](./split-cross-currency-transfer-tasks.md).

## Assumptions (verified against the tree, 2026-11-05)

- A split write replaces every line: `TransactionSplitService.updateSplits`
  and the split branch of `TransactionsService.update` call
  `deleteSplitSideEffects` and then `createSplits`, which converts each
  transfer line's counterpart in `resolveSplitTransferAmount`.
- The plain transfer's `toAmount` rules live in
  `TransactionTransferService.resolveTransferFx`; the split rules follow them.
- The editor opens a split for edit from `GET /transactions/:id` (the
  transactions page) or from a register row (category and payee tabs), so both
  reads carry each own line's counterpart amount.
- The plain transfer form's prefill is `useTransferFxAutofill`; its arithmetic
  (`receivedForSent`, `sentForReceived`) is shared, not copied.

## Phase 1: backend

- `CreateTransactionSplitDto.transferTargetAmount`; `resolveSplitTransferAmount`
  honours it; `validateSplits` and `addSplit` refuse it off a transfer line.
- `carryRecordedReceivedAmounts` (`split-received-amount.util.ts`) through
  `withRecordedReceivedAmounts` on both replacement paths, before the
  counterparts are deleted.
- `findOne` attaches `{ id, amount, currencyCode }` per line on the reader's own
  row; the register joins the same three columns and `ownSplitCounterpartsOnly`
  drops them from another owner's rows.
- `snapshotTransaction` records `receivedAmount`; `splitsEqualByValue`
  compares it when both snapshots have it.
- Run: `npm run test:unit -- transaction-split split-received-amount action-history`,
  `npm run test:integration -- split-transfer-received-amount`.
  Observe: a re-save that omits the figure keeps it with no rate stored.

## Phase 2: frontend

- `useSplitTransferFxAutofill` (one hook for every line), `split-transfer-currency.ts`
  (pair, fee direction, what to send), `SplitAmountFields` (the labelled pair),
  `split-rows.ts` (rows and serializers, re-exported by `SplitEditor`).
- `TransactionForm` passes `crossCurrencyTransfers`, loads received amounts
  only for the row being edited (`receivedAmountsIn`) and sends
  `receivedAmountToSend`.
- Run: `npm run test -- src/components/transactions`, `npm run lint`,
  `npm run type-check`, `npm run build`.
  Observe: a transfer line to a USD account under a CAD parent shows
  "Transfer Amount (CAD)" over "Amount Received (USD)", filled from the day's
  rate.

## Phase 3: documentation and locales

- `website/docs/transactions.md` (Split Transactions), then `npm run docs:build`.
- `docs/financial-semantics.md` section 5.
- The one new backend error key in every locale; `npm run i18n:pseudo`.
