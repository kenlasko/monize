import { randomUUID } from "node:crypto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import {
  MappedSplit,
  MappedTransaction,
  MappedTransactions,
} from "../../mny/model/mny-import-model";
import { KmySplit, KmyTransaction } from "../model/kmy-raw";
import { abs, compare, isZero, neg, sum } from "../model/kmy-rational";
import { KMY_TYPE, isAssetOrLiability } from "./kmy-account-tree";
import { impliedRate, isIsoDate, legRational, rateNumber } from "./kmy-amounts";
import { rawCurrencyOf } from "./kmy-map-accounts";
import {
  KmyMapContext,
  RowCollector,
  memoOf,
  numberOf,
  ordinaryRow,
  sharesOf,
  transactionCommodity,
  unitsOf,
} from "./kmy-row-builder";

/**
 * Spec 5.6: ordinary (non-investment) transactions, their splits and
 * transfers. A transaction with a split on a stock account belongs to
 * `kmy-map-investments`; one folded into an opening balance produces nothing.
 */

export interface KmyTransactionsResult {
  readonly transactions: MappedTransactions;
  /** Equity accounts (ordinals) used as a category by a written row. */
  readonly equityUsed: ReadonlySet<number>;
}

/** Spec 5.6.5: the status of the split a row takes its state from. */
interface Classified {
  /** Splits on asset/liability accounts (and type 0), document order. */
  readonly assets: KmySplit[];
  /** Splits on income, expense and equity accounts. */
  readonly categories: KmySplit[];
}

function classify(
  transaction: KmyTransaction,
  context: KmyMapContext,
): Classified {
  const assets: KmySplit[] = [];
  const categories: KmySplit[] = [];
  for (const split of transaction.splits) {
    const account = context.tree.byId.get(split.account);
    if (!account) {
      continue;
    }
    if (isAssetOrLiability(account.type) || account.type === KMY_TYPE.UNKNOWN) {
      assets.push(split);
    } else if (
      account.type === KMY_TYPE.INCOME ||
      account.type === KMY_TYPE.EXPENSE ||
      account.type === KMY_TYPE.EQUITY
    ) {
      categories.push(split);
    }
  }
  return { assets, categories };
}

/** True when any split is on a stock account: the transaction is an investment (spec 5.7). */
export function hasStockSplit(
  transaction: KmyTransaction,
  context: KmyMapContext,
): boolean {
  return transaction.splits.some(
    (split) => context.tree.byId.get(split.account)?.type === KMY_TYPE.STOCK,
  );
}

function mapOne(
  transaction: KmyTransaction,
  context: KmyMapContext,
  collector: RowCollector,
): void {
  const { assets, categories } = classify(transaction, context);
  if (assets.length === 0) {
    collector.warn(
      "unusableTransaction",
      transaction,
      "no asset or liability split",
    );
    return;
  }
  const imported = assets.filter((split) =>
    context.mapping.keyById.has(split.account),
  );
  if (imported.length === 0) {
    return;
  }

  // An asset plus one category is a plain row when the values balance; when
  // they do not, KMyMoney marks it erroneous and the difference becomes an
  // uncategorized leg of a split row (spec 5.6.3, the last row of 5.6.7).
  const balanced = isZero(sum(transaction.splits.map((split) => split.value)));
  if (
    assets.length === 1 &&
    (categories.length === 0 || (categories.length === 1 && balanced))
  ) {
    singleRow(transaction, assets[0], categories[0], context, collector);
    return;
  }
  if (assets.length === 2 && categories.length === 0) {
    transferPair(transaction, assets, imported, context, collector);
    return;
  }
  splitRow(transaction, assets, imported, categories, context, collector);
}

function singleRow(
  transaction: KmyTransaction,
  asset: KmySplit,
  category: KmySplit | undefined,
  context: KmyMapContext,
  collector: RowCollector,
): void {
  if (category === undefined) {
    collector.warn("singleSplitTransaction", transaction);
    collector.rows.push(ordinaryRow(transaction, asset, context, collector));
    return;
  }
  const account = context.tree.byId.get(category.account) as {
    ordinal: number;
    type: number;
  };
  if (account.type === KMY_TYPE.EQUITY) {
    collector.warn("equitySplitAsCategory", transaction);
  }
  const row = ordinaryRow(transaction, asset, context, collector, {
    categoryHandle: collector.category(account),
    tagHandles: collector.tagHandles([asset, category]),
  });
  collector.rows.push(row);
}

function transferPair(
  transaction: KmyTransaction,
  assets: KmySplit[],
  imported: KmySplit[],
  context: KmyMapContext,
  collector: RowCollector,
): void {
  if (imported.length === 1) {
    collector.warn("transferAcrossExcludedAccount", transaction);
    collector.rows.push(
      ordinaryRow(transaction, imported[0], context, collector),
    );
    return;
  }
  const [first, second] = assets;
  const rows = [first, second].map((split) =>
    ordinaryRow(transaction, split, context, collector, { isTransfer: true }),
  );
  rows[0] = { ...rows[0], linkedTransactionId: rows[1].id };
  rows[1] = { ...rows[1], linkedTransactionId: rows[0].id };
  const rate = transferRate(
    rows[0].currencyCode,
    splitUnits(first, transaction, rows[0].currencyCode, context),
    rows[1].currencyCode,
    splitUnits(second, transaction, rows[1].currencyCode, context),
    transaction.postDate as string,
    context,
  );
  rows[0] = { ...rows[0], exchangeRate: rate.first };
  rows[1] = { ...rows[1], exchangeRate: rate.second };
  if (rate.first === null || rate.second === null) {
    const receivesFirst = rate.first === null;
    warnTransferRateMissing(
      transaction,
      receivesFirst ? second : first,
      receivesFirst ? first : second,
      receivesFirst ? rows[1].currencyCode : rows[0].currencyCode,
      receivesFirst ? rows[0].currencyCode : rows[1].currencyCode,
      context,
      collector,
    );
  }
  collector.rows.push(...rows);
  collector.transfersLinked += 1;
}

/**
 * Spec 5.6.4, 9: a cross-currency transfer whose receiving leg ends up with no
 * rate (the amounts imply none, the file prices no such pair) is imported with
 * a null rate and the user is told which transfer to complete. The detail names
 * the date, the two accounts as KMyMoney names them, and the currency pair
 * (sending first); the review step's row carries the date and account too.
 */
function warnTransferRateMissing(
  transaction: KmyTransaction,
  sending: KmySplit,
  receiving: KmySplit,
  sendingCurrency: string,
  receivingCurrency: string,
  context: KmyMapContext,
  collector: RowCollector,
): void {
  const nameOf = (split: KmySplit): string =>
    context.tree.byId.get(split.account)?.name.trim() || split.account;
  collector.warn(
    "crossCurrencyTransferRateMissing",
    transaction,
    `${transaction.postDate}: ${nameOf(sending)} (${sendingCurrency}) to ${nameOf(receiving)} (${receivingCurrency})`,
  );
}

/**
 * Spec 5.6.4: the receiving row carries `|receiving| / |sending|` (receiving
 * currency per unit of the sending one), the sending row 1. Same currency, or
 * nothing on both sides: 1 on both. With one side empty the amounts imply
 * nothing, so the file's own price for the pair is used (spec 9), and a pair
 * the file does not price carries no rate (null), never 1.
 */
function transferRate(
  firstCurrency: string,
  firstUnits: bigint,
  secondCurrency: string,
  secondUnits: bigint,
  date: string,
  context: KmyMapContext,
): { first: number | null; second: number | null } {
  if (firstCurrency === secondCurrency) {
    return { first: 1, second: 1 };
  }
  if (firstUnits === 0n && secondUnits === 0n) {
    return { first: 1, second: 1 };
  }
  const firstReceives =
    firstUnits > 0n || (firstUnits === 0n && secondUnits < 0n);
  const [receivingUnits, sendingUnits] = firstReceives
    ? [firstUnits, secondUnits]
    : [secondUnits, firstUnits];
  const [receivingCurrency, sendingCurrency] = firstReceives
    ? [firstCurrency, secondCurrency]
    : [secondCurrency, firstCurrency];
  const rate = receivingRate(
    sendingCurrency,
    receivingCurrency,
    receivingUnits,
    sendingUnits,
    date,
    context,
  );
  return firstReceives
    ? { first: rate, second: 1 }
    : { first: 1, second: rate };
}

/**
 * Receiving currency per unit of the sending currency: what the two amounts
 * imply, else the file's own price for the pair on or before `date`, else null.
 */
function receivingRate(
  sendingCurrency: string,
  receivingCurrency: string,
  receivingUnits: bigint,
  sendingUnits: bigint,
  date: string,
  context: KmyMapContext,
): number | null {
  const implied = impliedRate(receivingUnits, sendingUnits);
  if (implied !== null) {
    return implied;
  }
  const filed = context.rateLookup(sendingCurrency, receivingCurrency, date);
  return filed.rate === null ? null : rateNumber(filed.rate);
}

/** A split's shares in the minor units of its (imported) account's currency. */
function splitUnits(
  split: KmySplit,
  transaction: KmyTransaction,
  currency: string,
  context: KmyMapContext,
): bigint {
  return unitsOf(sharesOf(split, transaction, context), currency, context);
}

function splitRow(
  transaction: KmyTransaction,
  assets: KmySplit[],
  imported: KmySplit[],
  categories: KmySplit[],
  context: KmyMapContext,
  collector: RowCollector,
): void {
  // Spec 5.6.2: the imported asset split with the largest absolute value.
  const parent = imported.reduce((best, split) =>
    compare(abs(split.value), abs(best.value)) > 0 ? split : best,
  );
  const parentAccount = context.tree.byId.get(parent.account);
  const parentKey = context.mapping.keyById.get(parent.account) as string;
  const parentCurrency = context.mapping.currencyByKey.get(parentKey) as string;
  const parentShares = sharesOf(parent, transaction, context);
  const commodity = transactionCommodity(transaction, context);
  const parentInCommodity =
    parentAccount !== undefined &&
    rawCurrencyOf(parentAccount, context.mapping.baseCurrency) === commodity;
  const parentUnits = unitsOf(parentShares, parentCurrency, context);

  const others = transaction.splits.filter(
    (split) =>
      split !== parent &&
      (assets.includes(split) || categories.includes(split)),
  );
  let unbalanced = !isZero(sum(transaction.splits.map((split) => split.value)));

  const legUnits = others.map((other): bigint => {
    const exact = legRational(
      other.value,
      parent.value,
      parentShares,
      parentInCommodity,
    );
    if (exact !== null) {
      return unitsOf(exact, parentCurrency, context);
    }
    const otherAccount = context.tree.byId.get(other.account);
    if (
      otherAccount &&
      parentAccount &&
      rawCurrencyOf(otherAccount, context.mapping.baseCurrency) ===
        rawCurrencyOf(parentAccount, context.mapping.baseCurrency)
    ) {
      return unitsOf(
        neg(sharesOf(other, transaction, context)),
        parentCurrency,
        context,
      );
    }
    unbalanced = true;
    return 0n;
  });

  const legSum = legUnits.reduce((total, units) => total + units, 0n);
  const residual = parentUnits - legSum;
  let uncategorized: bigint | null = null;
  if (unbalanced) {
    uncategorized = residual;
    collector.warn(
      "unbalancedTransaction",
      transaction,
      String(numberOf(residual, parentCurrency, context)),
    );
  } else if (residual !== 0n && legUnits.length > 0) {
    // Rounding residual: onto the leg with the largest absolute amount.
    let target = 0;
    legUnits.forEach((units, index) => {
      const mag = units < 0n ? -units : units;
      const best = legUnits[target] < 0n ? -legUnits[target] : legUnits[target];
      if (mag > best) {
        target = index;
      }
    });
    legUnits[target] += residual;
  }

  const parentRowId = randomUUID();
  const legs: MappedSplit[] = [];
  const counterparts: MappedTransaction[] = [];
  others.forEach((other, index) => {
    const account = context.tree.byId.get(other.account);
    const memo = memoOf(other.memo);
    const legAmount = numberOf(legUnits[index], parentCurrency, context);
    const counterpartKey = context.mapping.keyById.get(other.account);
    const isAsset = assets.includes(other);
    if (isAsset && counterpartKey !== undefined) {
      const counterpart = ordinaryRow(transaction, other, context, collector, {
        isTransfer: true,
        linkedTransactionId: parentRowId,
      });
      const receiving =
        counterpart.amount > 0 && counterpart.currencyCode !== parentCurrency;
      const rate = receiving
        ? receivingRate(
            parentCurrency,
            counterpart.currencyCode,
            splitUnits(other, transaction, counterpart.currencyCode, context),
            legUnits[index],
            transaction.postDate as string,
            context,
          )
        : 1;
      if (rate === null) {
        warnTransferRateMissing(
          transaction,
          parent,
          other,
          parentCurrency,
          counterpart.currencyCode,
          context,
          collector,
        );
      }
      counterparts.push({ ...counterpart, exchangeRate: rate });
      legs.push({
        id: randomUUID(),
        kind: SplitKind.TRANSFER,
        categoryHandle: null,
        transferAccountKey: counterpartKey,
        linkedTransactionId: counterpart.id,
        investmentHandle: null,
        amount: legAmount,
        memo,
        tagHandles: collector.tagHandles([other]),
      });
      collector.transfersLinked += 1;
      return;
    }
    if (isAsset) {
      collector.warn("transferAcrossExcludedAccount", transaction);
    }
    let categoryHandle: number | null = null;
    if (!isAsset && account) {
      if (account.type === KMY_TYPE.EQUITY) {
        collector.warn("equitySplitAsCategory", transaction);
      }
      categoryHandle = collector.category(account);
    }
    legs.push({
      id: randomUUID(),
      kind: SplitKind.CATEGORY,
      categoryHandle,
      transferAccountKey: null,
      linkedTransactionId: null,
      investmentHandle: null,
      amount: legAmount,
      memo,
      tagHandles: collector.tagHandles([other]),
    });
  });
  if (uncategorized !== null) {
    legs.push({
      id: randomUUID(),
      kind: SplitKind.CATEGORY,
      categoryHandle: null,
      transferAccountKey: null,
      linkedTransactionId: null,
      investmentHandle: null,
      amount: numberOf(uncategorized, parentCurrency, context),
      memo: null,
      tagHandles: [],
    });
  }

  const row = ordinaryRow(transaction, parent, context, collector, {
    splits: legs,
  });
  collector.rows.push({ ...row, id: parentRowId }, ...counterparts);
}

export function mapKmyTransactions(
  context: KmyMapContext,
  folded: ReadonlySet<number>,
): KmyTransactionsResult {
  const collector = new RowCollector(context);
  let skipped = 0;

  for (const transaction of context.raw.transactions) {
    if (
      folded.has(transaction.ordinal) ||
      hasStockSplit(transaction, context)
    ) {
      continue;
    }
    if (!isIsoDate(transaction.postDate)) {
      skipped += 1;
      collector.warn("unusableTransaction", transaction, "no usable date");
      continue;
    }
    const before = collector.rows.length;
    const warned = collector.warnings.length;
    mapOne(transaction, context, collector);
    if (
      collector.rows.length === before &&
      collector.warnings
        .slice(warned)
        .some((warning) => warning.code === "unusableTransaction")
    ) {
      skipped += 1;
    }
  }

  return {
    transactions: {
      transactions: collector.rows,
      referencedPayees: collector.payees,
      referencedCategories: collector.categories,
      referencedTags: collector.tags,
      tradeCashLegTagHandles: new Map(),
      transfersLinked: collector.transfersLinked,
      skipped,
      deferredInvestments: 0,
      tradeCashLegs: 0,
      investmentCashSources: new Map(),
      warnings: collector.warnings,
    },
    equityUsed: collector.equityUsed,
  };
}
