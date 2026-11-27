import { randomUUID } from "node:crypto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { isInvestmentActionAllowedInSplit } from "../../../securities/cash-impact.util";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { proceedsExcludingAccruedInterest } from "../../../securities/accrued-interest.util";
import { roundMoney } from "../../../common/round.util";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import {
  MappedSplit,
  MappedTransaction,
  MappedTransactions,
  MnyImportedTrade,
  MnyInvestmentCashSource,
} from "../model/mny-import-model";
import {
  billTemplateHandles,
  decodeReference,
  isLoanPaymentTemplate,
  isRecurrenceTemplate,
  isUnpostedRow,
  mapTransactionStatus,
} from "../model/mny-model";
import { MnyWarning, MnyWarningRow } from "../model/mny-warnings";
import { MnyTransactionData } from "../tables/read-transactions";
import { transactionTagHandles } from "./map-classifications";
import { TransferIndex, indexTransfers } from "./map-transfers";

/**
 * `TRN`, `TRN_SPLIT` and `TRN_XFER` mapped onto Monize transactions.
 *
 * The two rules that carry the most history:
 *
 * **The phantom filter is `frq != -1` and nothing else.** PR #192 also excluded
 * rows it read as auto-entered, but Money's scheduler posts real transactions --
 * including every loan payment -- so that filter is what made loan and mortgage
 * accounts import with zero transactions. Its sibling mistake outlived it:
 * `grftt & 0x80` was read as "voided" when it actually marks a row in a debt
 * account, so the loan payments that survived the filter all imported VOID and
 * dropped straight back out of the balance (see `MNY_TRANSACTION_FLAG`).
 *
 * **A split leg that is really a transfer stays a transfer.** PR #192 imported
 * every `TRN_SPLIT` child as a category-only row, so the principal leg of a loan
 * payment lost its transfer nature and showed blank. Here a child that appears
 * in `TRN_XFER` becomes a Monize transfer split pointing at the counterpart
 * transaction, which is imported exactly once as an ordinary row in the loan
 * account and links back to the *parent* payment -- the same wiring
 * `TransactionSplitService` produces for a hand-entered transfer split.
 */

export interface MapTransactionsInput {
  readonly transactions: MnyTransactionData;
  /** Money `hacct` -> account key, from `mapAccounts`. Absent = not imported. */
  readonly accountKeyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> the Monize account's currency. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
  /**
   * Brokerage account key -> its linked cash sleeve, from `mapAccounts`. A
   * transfer whose far side is an investment row lands in the sleeve, because
   * that is where Monize keeps a brokerage's cash.
   */
  readonly cashKeyByAccountKey: ReadonlyMap<string, string>;
  /**
   * The investment rows this import writes, by `TRN.htrn` -- from
   * `mapInvestments`, which runs first for exactly this reason.
   *
   * A banking row Money paired to one of these is that trade's cash side, and
   * which of the three shapes it is decides what gets written: the trade's own
   * sleeve row (issue #1175), a funding row in another account (issue #1212), or
   * a split leg the trade is embedded in (issue #1211). Without it the mapper
   * cannot tell a trade that will exist from one the investment mapper skipped,
   * and would wire a split or a funding link to nothing.
   */
  readonly tradesByHandle: ReadonlyMap<number, MnyImportedTrade>;
}

/**
 * The cash-sleeve side of a transfer between a bank account and an investment
 * account -- a transaction Money does not store, because its investment row is
 * both the transfer destination and the trade.
 */
interface CashCounterpart extends MappedTransaction {
  /** `TRN.htrn` of the investment row this is the cash side of. */
  readonly handle: number;
}

/** Everything the per-row mapping needs, computed once. */
interface Context {
  readonly input: MapTransactionsInput;
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  /** `TRN_SPLIT.htrn` -- rows that are legs of another transaction. */
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  /** Pre-generated ids for the rows that will be imported as transactions. */
  readonly idByHandle: ReadonlyMap<number, string>;
  /** Investment row handle -> the cash-sleeve transaction standing in for it. */
  readonly cashCounterparts: ReadonlyMap<number, CashCounterpart>;
  /** Top-level row handle -> the trade it funds from another account. */
  readonly externalFunders: ReadonlyMap<number, number>;
  /** Split leg handle -> the trade that leg embeds. */
  readonly investmentSplitLegs: ReadonlyMap<number, number>;
  /** Sleeve row handle -> the skipped investment row it is the cash side of. */
  readonly unwrittenTradeCashRows: ReadonlyMap<number, number>;
  readonly warnings: MnyWarning[];
}

/**
 * The flagged-row context a warning carries, so the review step can show the
 * user which transactions to look at in Money rather than a bare `htrn`.
 */
function warningRow(
  row: MnyTransaction,
  input: MapTransactionsInput,
): MnyWarningRow {
  return {
    handle: row.handle as number,
    accountKey:
      row.account === null
        ? null
        : (input.accountKeyByHandle.get(row.account) ?? null),
    date: row.date,
    amount: row.amount,
    payeeHandle: row.payee,
    reference: decodeReference(row.reference),
    memo: row.memo,
  };
}

interface Indexes {
  readonly byHandle: ReadonlyMap<number, MnyTransaction>;
  readonly parentOfChild: ReadonlyMap<number, number>;
  readonly childrenByParent: ReadonlyMap<number, MnyTransaction[]>;
  readonly billTemplates: ReadonlySet<number>;
  readonly transfers: TransferIndex;
  /**
   * Rows that are Money's own copy of a trade's cash leg, which Monize writes
   * from the investment transaction instead. See `classifyTradeCashSides`.
   */
  readonly tradeCashLegs: ReadonlySet<number>;
  /** Top-level row handle -> the trade it funds from another account. */
  readonly externalFunders: ReadonlyMap<number, number>;
  /** Split leg handle -> the trade that leg embeds. */
  readonly investmentSplitLegs: ReadonlyMap<number, number>;
  /**
   * Sleeve row handle -> the investment row it pairs with, for a pairing whose
   * trade this import does not write. See `classifyTradeCashSides`.
   */
  readonly unwrittenTradeCashRows: ReadonlyMap<number, number>;
  readonly warnings: MnyWarning[];
}

/** Everything the posting predicate reads before the trade-cash classification. */
type PostingIndexes = Omit<
  Indexes,
  | "tradeCashLegs"
  | "externalFunders"
  | "investmentSplitLegs"
  | "unwrittenTradeCashRows"
>;

function buildIndexes(input: MapTransactionsInput): Indexes {
  const warnings: MnyWarning[] = [];
  const rows = input.transactions.transactions;

  const byHandle = new Map(
    rows
      .filter((row) => row.handle !== null)
      .map((row) => [row.handle as number, row]),
  );

  const parentOfChild = new Map<number, number>();
  const childrenByParent = new Map<number, MnyTransaction[]>();

  // Ordered by `iSplit` so legs keep the order the user sees in Money.
  for (const split of [...input.transactions.splits].sort(
    (a, b) => a.position - b.position,
  )) {
    if (split.parent === null || split.child === null) {
      continue;
    }
    const child = byHandle.get(split.child);
    if (!child) {
      continue;
    }
    parentOfChild.set(split.child, split.parent);
    if (!byHandle.has(split.parent)) {
      warnings.push({
        code: "orphanedSplit",
        subject: `htrn=${split.child}`,
        detail: `parent htrn=${split.parent}`,
        row: warningRow(child, input),
      });
      continue;
    }
    childrenByParent.set(split.parent, [
      ...(childrenByParent.get(split.parent) ?? []),
      child,
    ]);
  }

  const base: PostingIndexes = {
    byHandle,
    parentOfChild,
    childrenByParent,
    billTemplates: billTemplateHandles(
      input.bills,
      input.transactions.transactions,
    ),
    transfers: indexTransfers(input.transactions.transfers, rows),
    warnings,
  };

  return { ...base, ...classifyTradeCashSides(rows, base, input) };
}

/**
 * Whether a row is a posting at all, before the trade-cash-leg rule.
 *
 * Split children, bill templates, recurrence templates (`frq != -1`),
 * loan-payment templates, scheduled instances Money never posted and genuinely
 * orphaned transfer sides are out. Scheduler-posted rows are **in**: they are
 * real postings, and excluding them emptied PR #192's loan accounts.
 *
 * Separate from `isImportablePosting` only because `classifyTradeCashSides` has to
 * ask this question in order to answer the other one.
 */
function isPostingRow(
  row: MnyTransaction,
  indexes: PostingIndexes,
  input: MapTransactionsInput,
): boolean {
  const handle = row.handle;
  return (
    handle !== null &&
    !indexes.parentOfChild.has(handle) &&
    !indexes.billTemplates.has(handle) &&
    !indexes.transfers.orphanedHandles.has(handle) &&
    !isRecurrenceTemplate(row.frequency) &&
    !isLoanPaymentTemplate(row.flags) &&
    !isUnpostedRow(row.flags) &&
    row.security === null &&
    row.date !== null &&
    row.account !== null &&
    input.accountKeyByHandle.has(row.account)
  );
}

/**
 * Whether a row is a real posting worth importing as a banking transaction:
 * a posting that Monize is not already writing from somewhere else.
 */
function isImportablePosting(
  row: MnyTransaction,
  indexes: Indexes,
  input: MapTransactionsInput,
): boolean {
  return (
    isPostingRow(row, indexes, input) &&
    !indexes.tradeCashLegs.has(row.handle as number)
  );
}

/**
 * Where the cash for each trade already sits, from Money's own `TRN_XFER`
 * pairings.
 *
 * Money records the cash half of a trade as an ordinary `TRN` row paired to the
 * investment row. There are three shapes, and Monize has a distinct model for
 * each -- the whole point of this function is that they are one question asked
 * once rather than three predicates that can disagree:
 *
 * **The trade's own sleeve (issue #1175).** Money keeps an investment account's
 * cash in a companion account and writes the cash side there -- `act` 1 does it
 * 2,015 times in 2,029, `act` 3 1,090 in 1,090. Monize writes that row itself
 * from the trade's `cashAmount`, linked through
 * `investment_transactions.transaction_id`, so importing Money's copy as well
 * put the same payment in the register three times: the purchase, a transfer in
 * and a transfer out. The row is dropped and the trade writes it instead. That
 * cannot move a balance, because the row and the counterpart
 * `buildCashCounterparts` used to synthesize for it always summed to zero.
 *
 * **A funding row in another account (issue #1212).** A purchase paid for out of
 * a chequing account. The row stays where Money put it and becomes the trade's
 * cash leg, with the trade recording it as its `funding_account_id` -- which is
 * what a natively entered trade funded from elsewhere already stores. Making it
 * a transfer into the sleeve instead left the sleeve holding a transfer in and
 * the trade's own leg taking it straight out again.
 *
 * **A leg of a split (issue #1211).** A paycheque with an investment purchase in
 * it. The leg becomes a `SplitKind.INVESTMENT` split with the trade embedded in
 * it through `transaction_split_id`, exactly as `createEmbeddedForSplit` writes
 * a hand-entered one; the leg's amount is the cash impact, so no cash row is
 * written anywhere. The old transfer-split shape put two more rows in the
 * sleeve, and showed the purchase as a transfer to an account the user never
 * chose.
 *
 * A pairing only qualifies when the far side is a trade **this import writes**
 * with a cash side of its own. A trade the investment mapper skipped, or one
 * that moves no cash, leaves Money's row alone: dropping it would lose the money
 * it records, and embedding a trade that does not exist would wire a split to
 * nothing.
 *
 * Such a row in the skipped trade's **own** sleeve is named here too
 * (`unwrittenTradeCashRows`). It keeps its money and imports as an ordinary
 * row, taking the investment row's category when it has none -- the same
 * treatment Money 99's other income and expenses get. Wiring it to a
 * synthesized counterpart instead puts that counterpart in the row's own
 * account, the pair nets to zero, and the cash Money shows in the sleeve is
 * gone: an interest payment whose `act` was unknown left a Money 99 cash
 * account short by exactly its amount.
 */
function classifyTradeCashSides(
  rows: readonly MnyTransaction[],
  indexes: PostingIndexes,
  input: MapTransactionsInput,
): {
  tradeCashLegs: ReadonlySet<number>;
  externalFunders: ReadonlyMap<number, number>;
  investmentSplitLegs: ReadonlyMap<number, number>;
  unwrittenTradeCashRows: ReadonlyMap<number, number>;
} {
  const tradeCashLegs = new Set<number>();
  const externalFunders = new Map<number, number>();
  const investmentSplitLegs = new Map<number, number>();
  const unwrittenTradeCashRows = new Map<number, number>();

  for (const row of rows) {
    const handle = row.handle;
    if (handle === null) {
      continue;
    }
    const partner = indexes.transfers.partnerByHandle.get(handle);
    if (partner === undefined) {
      continue;
    }
    const trade = input.tradesByHandle.get(partner);
    if (trade === undefined) {
      if (isUnwrittenTradeCashRow(row, partner, indexes, input)) {
        unwrittenTradeCashRows.set(handle, partner);
      }
      continue;
    }
    if (trade.cashAmount === 0) {
      continue;
    }

    const parent = indexes.parentOfChild.get(handle);
    if (parent !== undefined) {
      // A split leg. Its parent has already moved the whole amount, so the leg
      // is the trade's cash side and the trade belongs inside it.
      const parentRow = indexes.byHandle.get(parent);
      if (
        parentRow !== undefined &&
        isPostingRow(parentRow, indexes, input) &&
        isInvestmentActionAllowedInSplit(trade.action)
      ) {
        investmentSplitLegs.set(handle, partner);
      }
      continue;
    }

    // A split *parent* is not a cash side: its amount is the whole transaction,
    // of which the trade is at most one leg, and dropping it would take the
    // other legs with it. Money should never pair one, and if it does the row
    // keeps the old synthesized-counterpart treatment rather than being read as
    // something it is not.
    if (
      !isPostingRow(row, indexes, input) ||
      indexes.childrenByParent.has(handle)
    ) {
      continue;
    }

    const sleeveKey = input.cashKeyByAccountKey.get(trade.accountKey);
    if (sleeveKey !== undefined && sleeveKey === accountKeyOf(row, input)) {
      tradeCashLegs.add(handle);
    } else {
      externalFunders.set(handle, partner);
    }
  }

  return {
    tradeCashLegs,
    externalFunders,
    investmentSplitLegs,
    unwrittenTradeCashRows,
  };
}

/**
 * True for a top-level posting in the cash sleeve of the brokerage holding
 * `partner`, an investment row whose trade the investment mapper skipped.
 */
function isUnwrittenTradeCashRow(
  row: MnyTransaction,
  partner: number,
  indexes: PostingIndexes,
  input: MapTransactionsInput,
): boolean {
  const far = indexes.byHandle.get(partner);
  if (
    far === undefined ||
    far.security === null ||
    far.account === null ||
    indexes.parentOfChild.has(row.handle as number) ||
    indexes.childrenByParent.has(row.handle as number) ||
    !isPostingRow(row, indexes, input)
  ) {
    return false;
  }
  const brokerageKey = input.accountKeyByHandle.get(far.account);
  const sleeveKey =
    brokerageKey === undefined
      ? undefined
      : input.cashKeyByAccountKey.get(brokerageKey);
  return sleeveKey !== undefined && sleeveKey === accountKeyOf(row, input);
}

/**
 * The cash-sleeve transactions that make bank-to-investment transfers balance.
 *
 * Money stores such a transfer as a pair whose far side carries `hsec`: one row
 * that is simultaneously "cash arrived from chequing" and "shares were bought".
 * The investment mapper takes that row and writes the trade, including its cash
 * leg *out* of the sleeve -- so nothing was left to represent the cash coming
 * *in*, and the bank row, whose partner is not a banking transaction, imported
 * as an ordinary payment with no counterpart.
 *
 * Money then simply vanished: across the maintainer's file 2,718 top-level rows
 * and 537 split legs debited a bank account with nothing arriving anywhere, and
 * the sleeves absorbed the whole difference -- $604,161.81 negative in total,
 * of which $553,225.57 is this.
 *
 * So the missing side is synthesized here, in the sleeve, linked to the bank
 * row both ways. The sleeve then nets out: the transfer pays cash in, the
 * trade's own leg takes it out.
 *
 * A near side already *in* that sleeve needs none of this, and gets none: those
 * rows are `tradeCashLegs`, so `isImportablePosting` rejects them and `nearId`
 * is undefined before the far side is ever looked at. A synthesized row
 * mirroring its own account is what issue #1175 saw in the register.
 *
 * Neither does a near side that is the trade's *own* cash movement --
 * `externalFunders` and `investmentSplitLegs`. Those rows already record the
 * money, so standing in for them a second time is what issues #1212 and #1211
 * saw. What is left for this function is the pairing that genuinely has no
 * banking counterpart: a far row carrying a security whose trade this import
 * does not write, or writes with no cash side.
 */
function buildCashCounterparts(
  rows: readonly MnyTransaction[],
  indexes: Indexes,
  input: MapTransactionsInput,
  idByHandle: ReadonlyMap<number, string>,
  warnings: MnyWarning[],
): Map<number, CashCounterpart> {
  const counterparts = new Map<number, CashCounterpart>();

  for (const row of rows) {
    const handle = row.handle;
    if (handle === null) {
      continue;
    }

    // The near side has to be a row this import actually creates: a posting, or
    // a leg of one. A leg's transfer points back at its parent payment, the
    // same wiring `counterpartId` uses in the other direction.
    if (
      indexes.externalFunders.has(handle) ||
      indexes.investmentSplitLegs.has(handle) ||
      indexes.unwrittenTradeCashRows.has(handle)
    ) {
      continue;
    }

    const parent = indexes.parentOfChild.get(handle);
    const nearId =
      parent === undefined
        ? isImportablePosting(row, indexes, input)
          ? idByHandle.get(handle)
          : undefined
        : idByHandle.get(parent);
    if (nearId === undefined) {
      continue;
    }

    const partner = indexes.transfers.partnerByHandle.get(handle);
    if (partner === undefined || counterparts.has(partner)) {
      continue;
    }
    const far = indexes.byHandle.get(partner);
    // Only an investment row needs standing in for. Anything else either
    // imports as a banking transaction of its own or is genuinely excluded.
    if (!far || far.security === null || far.account === null) {
      continue;
    }
    const brokerageKey = input.accountKeyByHandle.get(far.account);
    const cashKey =
      brokerageKey === undefined
        ? undefined
        : input.cashKeyByAccountKey.get(brokerageKey);
    if (cashKey === undefined) {
      continue;
    }

    // The near row's account: a split leg may carry none, and then it is the
    // parent payment's account that the leg's money leaves.
    const nearAccount =
      row.account ??
      (parent === undefined ? null : indexes.byHandle.get(parent)?.account) ??
      null;
    const nearCurrency =
      nearAccount === null
        ? undefined
        : input.currencyByHandle.get(nearAccount);
    const farCurrency = input.currencyByHandle.get(far.account);
    // Each side carries its own account's amount in its own currency. Within
    // one currency the counterpart mirrors the bank side, so the pair sums to
    // zero; across currencies the mirror would credit the bank's amount under
    // the sleeve's currency, so the far row's own amount is used instead.
    const amount =
      nearCurrency !== undefined &&
      farCurrency !== undefined &&
      nearCurrency !== farCurrency
        ? roundMoney(Math.sign(-row.amount) * Math.abs(far.amount))
        : roundMoney(-row.amount);

    // Compare with Money's own far row rather than with the mapper's sums,
    // which the expected-balance check shares and so cannot disagree with.
    if (
      far.amount !== 0 &&
      roundMoney(Math.abs(amount)) !== roundMoney(Math.abs(far.amount))
    ) {
      warnings.push({
        code: "transferAmountMismatch",
        subject: `htrn=${partner}`,
        detail: `money ${far.amount} imported ${amount}`,
        row: warningRow(far, input),
      });
    }

    counterparts.set(partner, {
      id: randomUUID(),
      handle: partner,
      accountKey: cashKey,
      transactionDate: (far.date ?? row.date) as string,
      amount,
      currencyCode: farCurrency ?? "",
      // Money rows have always been written with rate 1.
      exchangeRate: 1,
      status: mapTransactionStatus(row.clearedStatus, row.flags),
      payeeHandle: row.payee,
      categoryHandle: null,
      description: row.memo,
      referenceNumber: null,
      isTransfer: true,
      linkedTransactionId: nearId,
      splits: [],
      collapsedTradeHandle: null,
      // Money's classification sits on the bank row, which keeps it; the
      // synthesized sleeve side is Monize's own row and carries none.
      tagHandles: [],
    });
  }

  return counterparts;
}

/** The Monize account a row's transaction belongs in, or null when not imported. */
function accountKeyOf(
  row: MnyTransaction | null,
  input: MapTransactionsInput,
): string | null {
  return row?.account === null || row?.account === undefined
    ? null
    : (input.accountKeyByHandle.get(row.account) ?? null);
}

/**
 * The transaction id a transfer counterpart should point at.
 *
 * When the counterpart is itself a split leg, the link goes to that leg's
 * **parent** transaction -- Monize records the split's own leg on
 * `transaction_splits.linked_transaction_id`, and the far side points back at the
 * parent payment.
 */
function counterpartId(partner: number, context: Context): string | null {
  const synthesized = context.cashCounterparts.get(partner);
  if (synthesized !== undefined) {
    return synthesized.id;
  }
  const throughParent = context.parentOfChild.get(partner);
  const target = throughParent ?? partner;
  return context.idByHandle.get(target) ?? null;
}

function mapSplitChild(
  child: MnyTransaction,
  context: Context,
): MappedSplit | null {
  const handle = child.handle;
  if (handle === null) {
    return null;
  }

  // A leg that pays for a trade embeds it (issue #1211): the leg's amount is
  // the trade's cash impact, so nothing is transferred and no cash row exists.
  const embeddedTrade = context.investmentSplitLegs.get(handle);
  if (embeddedTrade !== undefined) {
    return {
      id: randomUUID(),
      kind: SplitKind.INVESTMENT,
      categoryHandle: null,
      transferAccountKey: null,
      linkedTransactionId: null,
      investmentHandle: embeddedTrade,
      amount: child.amount,
      memo: child.memo,
      tagHandles: transactionTagHandles(child),
    };
  }

  const partner = context.transfers.partnerByHandle.get(handle) ?? null;
  const partnerRow =
    partner === null ? null : (context.byHandle.get(partner) ?? null);
  // A leg paying into an investment account lands in that account's cash
  // sleeve, not on the brokerage side where the shares are.
  const synthesized =
    partner === null ? undefined : context.cashCounterparts.get(partner);
  const partnerKey =
    synthesized?.accountKey ?? accountKeyOf(partnerRow, context.input);
  const partnerId = partner === null ? null : counterpartId(partner, context);

  // A split leg Money records in TRN_XFER is a transfer -- most often the
  // principal portion of a loan payment.
  if (partnerKey !== null && partnerId !== null) {
    return {
      id: randomUUID(),
      kind: SplitKind.TRANSFER,
      categoryHandle: null,
      transferAccountKey: partnerKey,
      linkedTransactionId: partnerId,
      investmentHandle: null,
      amount: child.amount,
      memo: child.memo,
      tagHandles: transactionTagHandles(child),
    };
  }

  if (partner !== null) {
    // The counterpart is not being imported. Keeping the leg as a category split
    // preserves the parent's total; dropping it would not.
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(child, context.input),
    });
  }

  return {
    id: randomUUID(),
    kind: SplitKind.CATEGORY,
    categoryHandle: child.category,
    transferAccountKey: null,
    linkedTransactionId: null,
    investmentHandle: null,
    amount: child.amount,
    memo: child.memo,
    tagHandles: transactionTagHandles(child),
  };
}

/**
 * The trade whose two-leg split this row can be collapsed into, or null.
 *
 * Money records a CD redemption that paid accrued interest as a split: the
 * investment leg for the principal, a second leg for the interest. Monize keeps
 * the interest on the redemption's own INTEREST companion, so the split has no
 * remaining purpose and the parent becomes the trade's single cash row.
 *
 * Deliberately narrow. A split that means anything else -- three legs, a
 * sibling whose amount is not the accrued interest, legs that do not sum to the
 * parent -- keeps the shape Money wrote, because rewriting a split on the
 * strength of one leg being a redemption would silently discard whatever else
 * the user recorded there.
 */
function collapsibleRedemptionTrade(
  splits: readonly MappedSplit[],
  parentAmount: number,
  context: Context,
): number | null {
  if (splits.length !== 2) return null;

  const investmentLegs = splits.filter(
    (split) => split.investmentHandle !== null,
  );
  if (investmentLegs.length !== 1) return null;

  const investmentLeg = investmentLegs[0];
  const interestLeg = splits.find((split) => split !== investmentLeg);
  if (interestLeg === undefined) return null;

  const trade = context.input.tradesByHandle.get(
    investmentLeg.investmentHandle as number,
  );
  if (
    trade === undefined ||
    trade.action !== InvestmentAction.REDEEM ||
    !(trade.accruedInterest > 0)
  ) {
    return null;
  }

  const interest = roundMoney(Math.abs(interestLeg.amount));
  if (interest !== roundMoney(trade.accruedInterest)) return null;

  // The principal leg has to be the redemption's proceeds, and the two legs
  // Money's own total, or this is not the shape it looks like.
  const proceeds = proceedsExcludingAccruedInterest(
    Math.abs(trade.cashAmount),
    trade.accruedInterest,
  );
  if (roundMoney(Math.abs(investmentLeg.amount)) !== proceeds) return null;
  if (
    roundMoney(investmentLeg.amount + interestLeg.amount) !==
    roundMoney(parentAmount)
  ) {
    return null;
  }

  return investmentLeg.investmentHandle;
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  context: Context,
): MappedTransaction {
  const handle = row.handle as number;
  const allSplits = (context.childrenByParent.get(handle) ?? [])
    .map((child) => mapSplitChild(child, context))
    .filter((split): split is MappedSplit => split !== null);
  const collapsedTradeHandle = collapsibleRedemptionTrade(
    allSplits,
    row.amount,
    context,
  );
  // A redemption Money wrote as principal + interest is one movement of money
  // in Monize: the interest lives on the trade's INTEREST companion, so this
  // row records the whole payout and the trade adopts it.
  const splits = collapsedTradeHandle === null ? allSplits : [];

  if (splits.length > 0) {
    const legTotal = roundMoney(
      splits.reduce((sum, split) => sum + split.amount, 0),
    );
    const total = roundMoney(row.amount);
    if (legTotal !== total) {
      context.warnings.push({
        code: "splitSumMismatch",
        subject: `htrn=${handle}`,
        detail: `legs ${legTotal} vs total ${total}`,
        row: warningRow(row, context.input),
      });
    }
  }

  // A split parent is never itself a transfer: its transfer legs are splits.
  // Neither is a row funding a trade in another account -- Money pairs it with
  // the trade, but in Monize that row *is* the trade's cash leg (issue #1212).
  // Nor is a sleeve row whose trade was skipped: there is no trade to pair it
  // with, so it stands alone and keeps the money Money shows.
  const skippedTrade = context.unwrittenTradeCashRows.get(handle);
  const partner =
    splits.length > 0 ||
    context.externalFunders.has(handle) ||
    skippedTrade !== undefined
      ? null
      : (context.transfers.partnerByHandle.get(handle) ?? null);
  const linkedTransactionId =
    partner === null ? null : counterpartId(partner, context);

  if (partner !== null && linkedTransactionId === null) {
    context.warnings.push({
      code: "transferAcrossExcludedAccount",
      subject: `htrn=${handle}`,
      detail: `partner htrn=${partner}`,
      row: warningRow(row, context.input),
    });
  }

  // A funding row and the trade it pays for are one movement of money, so they
  // share the VOID boundary: a row claiming the cash moved beside a trade that
  // says it did not is the pair describing two different events. Only VOID --
  // reconciliation states are per-ledger.
  const fundedTrade = context.externalFunders.get(handle);
  const tradeStatus =
    fundedTrade === undefined
      ? undefined
      : context.input.tradesByHandle.get(fundedTrade)?.status;
  const status =
    tradeStatus === TransactionStatus.VOID
      ? TransactionStatus.VOID
      : mapTransactionStatus(row.clearedStatus, row.flags);

  return {
    id: context.idByHandle.get(handle) as string,
    handle,
    accountKey,
    transactionDate: row.date as string,
    amount: row.amount,
    currencyCode:
      context.input.currencyByHandle.get(row.account as number) ?? "",
    // Money rows have always been written with rate 1.
    exchangeRate: 1,
    status,
    payeeHandle: row.payee,
    // A split parent carries no category of its own: the legs do.
    categoryHandle:
      splits.length > 0
        ? null
        : (row.category ??
          (skippedTrade === undefined
            ? null
            : (context.byHandle.get(skippedTrade)?.category ?? null))),
    description: row.memo,
    referenceNumber: decodeReference(row.reference),
    isTransfer: linkedTransactionId !== null,
    linkedTransactionId,
    splits,
    collapsedTradeHandle,
    tagHandles: transactionTagHandles(row),
  };
}

/**
 * Rows a real posting could not be made of, reported once each.
 *
 * A `tradeCashLegs` row is not one of them and deliberately raises nothing: it
 * is a perfectly usable posting that Monize writes from the trade instead, so
 * counting it as skipped would report data loss that did not happen. Its own
 * count travels as `MappedTransactions.tradeCashLegs`.
 */
function reportUnusable(
  rows: readonly MnyTransaction[],
  indexes: Indexes,
  input: MapTransactionsInput,
  warnings: MnyWarning[],
): number {
  let skipped = 0;

  for (const row of rows) {
    const handle = row.handle;
    if (
      handle === null ||
      indexes.parentOfChild.has(handle) ||
      indexes.billTemplates.has(handle) ||
      isRecurrenceTemplate(row.frequency) ||
      isLoanPaymentTemplate(row.flags) ||
      isUnpostedRow(row.flags) ||
      row.security !== null
    ) {
      continue;
    }

    if (indexes.transfers.orphanedHandles.has(handle)) {
      // A dangling TRN_XFER reference: Money's own phantom row.
      skipped += 1;
      warnings.push({
        code: "orphanedTransferSide",
        subject: `htrn=${handle}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (row.account === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no account",
        row: warningRow(row, input),
      });
      continue;
    }

    // An account the user left out is a choice, not a data problem.
    if (!input.accountKeyByHandle.has(row.account)) {
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${handle}`,
        detail: "no usable date",
        row: warningRow(row, input),
      });
    }
  }

  return skipped;
}

/** Distinct transfer pairs where both top-level sides were imported. */
function countPlainTransferPairs(context: Context): number {
  const counted = new Set<number>();

  for (const [handle, partner] of context.transfers.partnerByHandle) {
    if (counted.has(handle) || counted.has(partner)) {
      continue;
    }
    const linked = (side: number): boolean =>
      context.idByHandle.has(side) || context.cashCounterparts.has(side);
    if (
      linked(handle) &&
      linked(partner) &&
      !context.parentOfChild.has(handle) &&
      !context.parentOfChild.has(partner)
    ) {
      counted.add(handle);
      counted.add(partner);
    }
  }

  return counted.size / 2;
}

/**
 * The rows that already record a trade's cash, keyed by the trade's `TRN.htrn`.
 *
 * Read back off the mapped output rather than accumulated while mapping, so a
 * source can only name an id that is actually going to be written -- the split
 * ids in particular exist only once `mapSplitChild` has produced the leg.
 * `TRN_XFER` is a bijection (`indexTransfers`), so a trade has at most one.
 */
function collectInvestmentCashSources(
  transactions: readonly MappedTransaction[],
  indexes: Indexes,
): Map<number, MnyInvestmentCashSource> {
  const sources = new Map<number, MnyInvestmentCashSource>();

  for (const transaction of transactions) {
    const funded = indexes.externalFunders.get(transaction.handle);
    if (funded !== undefined) {
      sources.set(funded, {
        accountKey: transaction.accountKey,
        currencyCode: transaction.currencyCode,
        amount: transaction.amount,
        status: transaction.status,
        transactionId: transaction.id,
        splitId: null,
      });
    }

    // A collapsed redemption split: the parent row itself is now the cash leg,
    // so it is registered exactly as an external funding row is. Without this
    // the trade would write a second cash row of its own beside it.
    if (transaction.collapsedTradeHandle !== null) {
      sources.set(transaction.collapsedTradeHandle, {
        accountKey: transaction.accountKey,
        currencyCode: transaction.currencyCode,
        amount: transaction.amount,
        status: transaction.status,
        transactionId: transaction.id,
        splitId: null,
      });
    }

    for (const split of transaction.splits) {
      if (split.investmentHandle === null) {
        continue;
      }
      sources.set(split.investmentHandle, {
        accountKey: transaction.accountKey,
        currencyCode: transaction.currencyCode,
        amount: split.amount,
        // The parent's, not the leg's: an embedded row's status is the
        // parent's, the same rule `createEmbeddedForSplit` applies.
        status: transaction.status,
        transactionId: null,
        splitId: split.id,
      });
    }
  }

  return sources;
}

/**
 * Maps banking transactions, deferring anything that carries a security to the
 * investment mapper (Phase 2 reads the same tables).
 *
 * Every transaction id is pre-generated (design ADR-9) so transfer pairs and
 * transfer splits are fully wired before the first INSERT and the writer needs no
 * second pass to discover them.
 */
/**
 * One category per transfer (INV-CATEGORY-002,
 * `docs/specs/transfer-categories.md` section 4.5): both legs of a linked
 * pair take the file's category. Money records one per row, so when the two
 * legs name different ones the outgoing leg's is kept; when only one names a
 * category, both take it. A row that is not one leg of a two-way pair is left
 * as mapped.
 */
export function withOneCategoryPerTransfer(
  transactions: readonly MappedTransaction[],
): MappedTransaction[] {
  const byId = new Map(transactions.map((row) => [row.id, row]));
  const chosen = new Map<string, number | null>();
  for (const row of transactions) {
    if (!row.isTransfer || row.linkedTransactionId === null) continue;
    const partner = byId.get(row.linkedTransactionId);
    if (partner === undefined || partner.linkedTransactionId !== row.id) {
      continue;
    }
    // One answer from either side: the leg with the lower amount (the
    // outgoing one of a pair with opposite signs), the lower id on a tie.
    const [first, second] =
      row.id < partner.id ? [row, partner] : [partner, row];
    const outgoing = second.amount < first.amount ? second : first;
    const incoming = outgoing === first ? second : first;
    chosen.set(row.id, outgoing.categoryHandle ?? incoming.categoryHandle);
  }
  return transactions.map((row) => {
    const categoryHandle = chosen.get(row.id);
    return categoryHandle === undefined || categoryHandle === row.categoryHandle
      ? row
      : { ...row, categoryHandle };
  });
}

export function mapTransactions(
  input: MapTransactionsInput,
): MappedTransactions {
  const indexes = buildIndexes(input);
  const rows = input.transactions.transactions;
  const warnings = indexes.warnings;

  const idByHandle = new Map<number, string>(
    rows
      .filter((row) => isImportablePosting(row, indexes, input))
      .map((row) => [row.handle as number, randomUUID()]),
  );

  const cashCounterparts = buildCashCounterparts(
    rows,
    indexes,
    input,
    idByHandle,
    warnings,
  );

  const context: Context = {
    input,
    byHandle: indexes.byHandle,
    parentOfChild: indexes.parentOfChild,
    childrenByParent: indexes.childrenByParent,
    billTemplates: indexes.billTemplates,
    transfers: indexes.transfers,
    idByHandle,
    cashCounterparts,
    externalFunders: indexes.externalFunders,
    investmentSplitLegs: indexes.investmentSplitLegs,
    unwrittenTradeCashRows: indexes.unwrittenTradeCashRows,
    warnings,
  };

  const transactions = withOneCategoryPerTransfer([
    ...rows
      .filter((row) => isImportablePosting(row, indexes, input))
      .map((row) => mapOne(row, accountKeyOf(row, input) as string, context)),
    ...cashCounterparts.values(),
  ]);

  const referencedPayees = new Set(
    transactions
      .map((transaction) => transaction.payeeHandle)
      .filter((handle): handle is number => handle !== null),
  );
  const referencedCategories = new Set(
    transactions
      .flatMap((transaction) => [
        transaction.categoryHandle,
        ...transaction.splits.map((split) => split.categoryHandle),
      ])
      .filter((handle): handle is number => handle !== null),
  );

  // Money's own sleeve-side cash rows are not imported; the trade writes the
  // leg. Their classification goes with it (`adoptCashLegTags`).
  const tradeCashLegTagHandles = new Map<number, readonly number[]>();
  for (const handle of indexes.tradeCashLegs) {
    const row = indexes.byHandle.get(handle);
    const trade = indexes.transfers.partnerByHandle.get(handle);
    const handles = row === undefined ? [] : transactionTagHandles(row);
    if (trade !== undefined && handles.length > 0) {
      tradeCashLegTagHandles.set(trade, handles);
    }
  }

  const referencedTags = new Set(
    transactions.flatMap((transaction) => [
      ...transaction.tagHandles,
      ...transaction.splits.flatMap((split) => split.tagHandles),
    ]),
  );

  const transferSplits = transactions.reduce(
    (count, transaction) =>
      count +
      transaction.splits.filter((split) => split.kind === SplitKind.TRANSFER)
        .length,
    0,
  );

  return {
    transactions,
    referencedPayees,
    referencedCategories,
    referencedTags,
    tradeCashLegTagHandles,
    transfersLinked: countPlainTransferPairs(context) + transferSplits,
    skipped: reportUnusable(rows, indexes, input, warnings),
    tradeCashLegs: indexes.tradeCashLegs.size,
    investmentCashSources: collectInvestmentCashSources(transactions, indexes),
    deferredInvestments: rows.filter(
      (row) =>
        row.security !== null &&
        row.handle !== null &&
        !indexes.parentOfChild.has(row.handle) &&
        !isRecurrenceTemplate(row.frequency),
    ).length,
    warnings,
  };
}
