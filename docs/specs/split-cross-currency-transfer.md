# Spec: cross-currency transfer lines in a split

Status: implemented on `claude/sweet-feynman-rmu9zw`, written after the first
cut was reviewed (the review asked for it; the decisions below are the ones the
code now makes).

Read `docs/financial-semantics.md` section 2 ("Transfers") and section 5
("A transfer line's received amount") before changing anything here.

## 1. What a line records

A split's transfer line moves `amount` (signed, in the parent account's
currency) to or from `transferAccountId`. Its counterpart row in the target
account is in the target's currency. When the two currencies differ, the line
may state `transferTargetAmount`: the unsigned amount that arrived, which is
what the bank actually credited after its rate and fees.

## 2. Invariants

Catalogued in `docs/system-invariants.md` as INV-SPLITFX-001 to -003; the
letters below name their parts.

- **INV-SPLITFX-001 (a).** The counterpart's amount is the stated received amount when
  there is one, signed opposite to the line; its `exchangeRate` is the implied
  `roundFxRate(received / |amount|)`. Without one it is the market conversion
  for the parent's date (`resolveFxRateOrNull`), and no rate refuses the write.
- **INV-SPLITFX-001 (b).** A same-currency line moves the same amount on both sides; a
  stated received amount that differs is refused
  (`transferSameCurrencyMustConserve`). Zero on one side only is refused
  (`transferAmountsMustAgreeOnZero`). A received amount on a line that is not a
  transfer is refused (`splitTransferTargetAmountRequiresTransfer`).
- **INV-SPLITFX-002 (a).** A received amount is a fact about the transfer. A split write
  replaces every line, so a line that continues a recorded one (same target,
  same amount, parent account unchanged) keeps its recorded received amount
  when the caller states none (`carryRecordedReceivedAmounts`); a line stating
  its own figure claims its recorded match first, so a new identical line does
  not inherit one. A changed line is re-converted.
- **INV-SPLITFX-002 (b).** A received amount belongs to one pair. On the client it is
  tagged with the parent currency it was stated against
  (`transferTargetFromCurrency`); once the parent moves to another currency it
  is neither shown nor sent, and is re-derived for the new pair; a stated
  figure comes back when the parent returns to its currency with the line
  unchanged: the same counterpart account and the same amount. A line pointed
  at another account starts empty and is filled from that pair's rate.
- **INV-SPLITFX-002 (c).** A duplicate or quick fill does not copy a received amount: the
  new row's comes from the rate for its own date.
- **INV-SPLITFX-002 (d).** Undo or redo of an edit that changed what a line received is
  refused like any other change to a leg-carrying line
  (`UNDO_SPLIT_LEGS_CHANGED`); history snapshots carry `receivedAmount`.
- **INV-SPLITFX-003.** Only the reader's own split carries its lines' counterparts in
  a read; a joint reader gets none.

## 3. The prefill

The editor fills the empty side from the day's rate less the converting
account's fee, exactly as the plain transfer form does
(`receivedForSent` / `sentForReceived`): the fee is the sending account's (the
parent's for a line taking money out, the target's for a line bringing money
in), the other's only when the sender has none. Each figure is rounded to its
own currency's decimal places. A side the user typed is never re-priced; a
derived side is re-derived when the amount, date, account or rate moves.

## 4. Numerical examples

| Parent | Line | Target | Rate | Fee | Received | Counterpart | Stored rate |
|---|---|---|---|---|---|---|---|
| CAD | -40.00 | USD | 0.73 | none | 29.20 (prefill) | +29.20 USD | 0.73 |
| CAD | -40.00 | USD | 0.73 | none | 28.75 (typed) | +28.75 USD | 0.71875 |
| CAD | +40.00 | USD | 0.73 | none | 29.20 | -29.20 USD | 0.73 |
| CAD | -100.00 | USD | 0.73 | 2.5% (parent) | 71.17 | +71.17 USD | 0.7117 |
| CAD | -40.00 | JPY | 108.37 | none | 4335 | +4335 JPY | 108.375 |
| CAD | -40.00 | CAD | -- | -- | 39.00 (sent) | refused | -- |

## 5. Missing data

No rate for the date: the editor fills nothing and says nothing new (the
received field stays empty); the server converts at the market rate or, with
none, refuses with `transferRateUnavailable`, which names the pair. A stated
received amount needs no rate.

## 6. Test matrix

| Claim | Test |
|---|---|
| INV-SPLITFX-001 | `transaction-split.service.spec.ts` "transferTargetAmount"; `split-transfer-received-amount.integration.spec.ts` |
| INV-SPLITFX-002 (a) | `split-received-amount.util.spec.ts`; the integration "re-save omits it" and "amount changed" cases |
| INV-SPLITFX-002 (b) | `useSplitTransferFxAutofill.test.ts`; `SplitEditor.crossCurrency.test.tsx` "parent currency changes", "another destination account"; `split-transfer-currency.test.ts` |
| INV-SPLITFX-002 (c) | `SplitEditor.crossCurrency.test.tsx` "loads none for a duplicate or quick fill" |
| INV-SPLITFX-002 (d) | `action-history.service.spec.ts` "changed only what a line received" |
| INV-SPLITFX-003 | `split-received-amount.util.spec.ts` "ownSplitCounterpartsOnly"; the integration "joint reader" case |
| Prefill fee and precision | `split-transfer-currency.test.ts`; `useTransferFxAutofill.test.ts` "precision" |

## 7. Out of scope

Scheduled transactions, their overrides and the Post dialog store split lines
in their own tables with no received amount; they convert when the occurrence
posts.
