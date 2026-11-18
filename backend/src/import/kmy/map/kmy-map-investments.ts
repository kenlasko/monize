import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  orderForReplay,
  pairShareTransfers,
} from "../../mny/map/map-investments";
import { roundFxRate } from "../../../common/fx-entry.util";
import { derivePriceFromTotal } from "../../../securities/investment-amount.util";
import {
  MappedInvestmentTransaction,
  MappedInvestments,
  MappedSplit,
  MappedTransaction,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmySplit, KmyTransaction } from "../model/kmy-raw";
import {
  Rational,
  ONE,
  abs,
  div,
  isZero,
  mul,
  sign,
} from "../model/kmy-rational";
import {
  amountNumber,
  isIsoDate,
  quantityNumber,
  rateNumber,
} from "./kmy-amounts";
import { KmyActivity, KmyDissection, dissectTransaction } from "./kmy-dissect";
import { embeddingSplitRow, hasStockSplit } from "./kmy-map-transactions";
import {
  RowCollector,
  ordinaryRow,
  statusOfSplit,
  transactionCommodity,
  warningContext,
} from "./kmy-row-builder";
import {
  CashOnlyReason,
  Holding,
  KmyInvestmentContext,
  NO_CASH,
  planCash,
  resolveHolding,
} from "./kmy-investment-holding";
import { sortableRowIds } from "./kmy-row-ids";
import { STEP_EVERY, Steps, runSteps } from "./kmy-steps";
import { checkStockSplits, journalOrder } from "./kmy-stock-splits";
import { tradeAmounts } from "./kmy-trade-amounts";
import { warningRowFor, warningRowForInvestment } from "./kmy-warning-row";

/**
 * Spec 5.7.2 to 5.7.6: investment transactions. The activity table, where the
 * cash moves, the shapes that import as cash only, extra splits, and the
 * pairing of share moves between brokerage accounts.
 */

export interface KmyInvestmentsResult {
  readonly investments: MappedInvestments;
  /**
   * Ordinary rows an investment transaction also produces (the cash side of a
   * shape that cannot import as a trade, and extra asset splits). The caller
   * appends them to the banking rows.
   */
  readonly cashRows: readonly MappedTransaction[];
  /** What `cashRows` reference, for the referenced-only filters. */
  readonly cashReferences: {
    readonly payees: ReadonlySet<number>;
    readonly categories: ReadonlySet<number>;
    readonly tags: ReadonlySet<number>;
  };
  readonly equityUsed: ReadonlySet<number>;
}

const INCOME_ACTIVITIES: ReadonlySet<KmyActivity> = new Set([
  "Dividend",
  "Yield",
  "IntIncome",
]);

/**
 * Spec 5.7.7: a transaction KMyMoney cannot classify as an investment
 * activity (no stock split with a recognised action), or a trade whose cash
 * moves against its activity -- a buy that pays cash in, a sale that pays it
 * out. Read as a trade, the first becomes a buy by default and the second
 * turns salary into investment income and taxes into commission.
 */
function unfitShape(d: KmyDissection): boolean {
  if (!d.recognised) {
    return true;
  }
  const cash = d.asset === null ? 0 : sign(d.asset.value);
  return (
    (d.activity === "BuyShares" && cash > 0) ||
    (d.activity === "SellShares" && cash < 0)
  );
}

class InvestmentMapper {
  readonly collector: RowCollector;
  readonly rows: MappedInvestmentTransaction[] = [];
  readonly cashCollector: RowCollector;
  readonly warnings: MnyWarning[] = [];
  /** Ids in the order rows are made, which is KMyMoney's journal order (S1). */
  private readonly nextId = sortableRowIds();
  skipped = 0;

  constructor(private readonly context: KmyInvestmentContext) {
    this.collector = new RowCollector(context);
    this.cashCollector = new RowCollector(context);
  }

  private warn(
    code: MnyWarning["code"],
    transaction: KmyTransaction,
    detail?: string,
  ): void {
    this.warnings.push({
      code,
      subject: `transaction ${transaction.ordinal}`,
      ...(detail === undefined ? {} : { detail }),
      row: warningRowFor(transaction, warningContext(this.context)),
    });
  }

  map(transaction: KmyTransaction): void {
    if (!isIsoDate(transaction.postDate)) {
      this.skipped += 1;
      this.warn("unusableTransaction", transaction, "no usable date");
      return;
    }
    const dissection = dissectTransaction(transaction, this.context.tree);
    if (dissection === null) {
      return;
    }
    const resolved = resolveHolding(this.context, dissection.stockAccount.id);
    if ("reason" in resolved) {
      this.cashOnly(transaction, dissection, resolved.reason);
      return;
    }
    if (unfitShape(dissection)) {
      // Never coerced into a trade silently (spec 5.7.7).
      this.warn(
        "investmentTransactionUnclassified",
        transaction,
        dissection.stock.action || undefined,
      );
      if (this.embed(transaction, dissection)) {
        return;
      }
    }
    this.trade(transaction, dissection, resolved.holding);
  }

  /**
   * Spec 5.7.7: the cash and category legs as an ordinary split row, and each
   * stock split's share movement as its own BUY or SELL at the stock split's
   * own value, embedded in that row's INVESTMENT leg (`transaction_split_id`),
   * so no cash row is written and the row's account moves by exactly its
   * shares. False, with nothing written, when there is no imported asset split
   * to hold the row, or a stock split that cannot become such a row (no
   * holding, or a value without shares).
   */
  private embed(transaction: KmyTransaction, d: KmyDissection): boolean {
    const { context } = this;
    const stocks = [d.stock, ...d.extraStocks];
    const holdings = stocks.map((split) =>
      resolveHolding(context, split.account),
    );
    if (
      holdings.some((h) => "reason" in h) ||
      stocks.some((split) => isZero(split.shares) && !isZero(split.value))
    ) {
      return false;
    }
    const priced = stocks.filter((split) => !isZero(split.value));
    const embedded = embeddingSplitRow(
      transaction,
      priced,
      context,
      this.cashCollector,
    );
    if (embedded === null) {
      return false;
    }
    const { parent, investmentLegs } = embedded;
    const commodity = transactionCommodity(transaction, context);
    stocks.forEach((split, index) => {
      const holding = (holdings[index] as { holding: Holding }).holding;
      const leg = investmentLegs.get(split) ?? null;
      this.rows.push(
        this.embeddedRow(transaction, split, holding, commodity, parent, leg),
      );
    });
    return true;
  }

  private embeddedRow(
    transaction: KmyTransaction,
    split: KmySplit,
    holding: Holding,
    commodity: string,
    parent: MappedTransaction,
    leg: MappedSplit | null,
  ): MappedInvestmentTransaction {
    const { context } = this;
    const conversion = this.conversion(transaction, holding, commodity);
    const money = (value: Rational): number =>
      amountNumber(value, conversion.currency, context.coinDecimals);
    const positive = sign(split.shares) > 0;
    const quantity = quantityNumber(abs(split.shares));
    const action =
      leg === null
        ? positive
          ? InvestmentAction.ADD_SHARES
          : InvestmentAction.REMOVE_SHARES
        : positive
          ? InvestmentAction.BUY
          : InvestmentAction.SELL;
    const total =
      leg === null ? 0 : money(abs(mul(split.value, conversion.rate)));
    const cashAmount = leg?.amount ?? 0;
    return {
      id: this.nextId(),
      handle: transaction.ordinal,
      accountKey: holding.pair.brokerageKey,
      cashAccountKey: leg === null ? null : parent.accountKey,
      fundingAccountKey: null,
      cashTransactionId: null,
      transactionSplitId: leg?.id ?? null,
      securityHandle: holding.securityHandle,
      action,
      transactionDate: transaction.postDate as string,
      quantity,
      price:
        leg === null
          ? null
          : derivePriceFromTotal({
              action,
              totalAmount: total,
              quantity,
              commission: 0,
            }),
      commission: 0,
      accruedInterest: 0,
      totalAmount: total,
      currencyCode: parent.currencyCode,
      securityCurrencyCode: conversion.currency,
      exchangeRate:
        leg === null ||
        parent.currencyCode === conversion.currency ||
        total === 0
          ? 1
          : roundFxRate(Math.abs(cashAmount) / total),
      cashAmount,
      // An embedded row takes its parent's status (`createEmbeddedForSplit`).
      status: parent.status,
      payeeHandle: this.payeeOf(transaction, [split, ...transaction.splits]),
      categoryHandle: null,
      description:
        [split.memo, transaction.memo].find((text) => text.trim() !== "") ??
        null,
      linkedInvestmentId: null,
      tagHandles: this.collector.tagHandles([split]),
    };
  }

  /**
   * The file's rate from the transaction commodity to the security's trading
   * currency (spec 5.7.3, under `resolveFxRate`'s bound), or the commodity
   * itself, unconverted and warned, when the file has none.
   */
  private conversion(
    transaction: KmyTransaction,
    holding: Holding,
    commodity: string,
  ): { rate: Rational; currency: string } {
    if (commodity === holding.securityCurrency) {
      return { rate: ONE, currency: commodity };
    }
    const found = this.context.rateLookup(
      commodity,
      holding.securityCurrency,
      transaction.postDate as string,
    );
    if (found.rate !== null) {
      return { rate: found.rate, currency: holding.securityCurrency };
    }
    // A rate the file has but that is too old for the date is named, so
    // the user can tell "no rate" from "a rate from years before".
    const pair = `${commodity}->${holding.securityCurrency}`;
    this.warn(
      "crossCurrencyTradeUnconverted",
      transaction,
      found.observedOn === null ? pair : `${pair} (${found.observedOn})`,
    );
    return { rate: ONE, currency: commodity };
  }

  /** Spec 5.7.6: the asset split becomes an ordinary row; fees and income do not import. */
  private cashOnly(
    transaction: KmyTransaction,
    dissection: KmyDissection,
    reason: CashOnlyReason,
  ): void {
    if (reason === "stockWithoutInvestment") {
      this.warn("stockAccountWithoutInvestment", transaction);
    }
    if (reason !== "silent") {
      this.skipped += 1;
      this.warn("investmentImportedAsCash", transaction);
    }
    const asset = dissection.asset;
    if (asset && this.context.mapping.keyById.has(asset.account)) {
      this.cashCollector.rows.push(
        ordinaryRow(transaction, asset, this.context, this.cashCollector, {
          descriptionSource:
            dissection.stock.memo || asset.memo || transaction.memo,
        }),
      );
    }
    this.extraAssets(transaction, dissection);
  }

  /**
   * Every asset split the trade itself does not use becomes an ordinary row in
   * its own account (spec 5.7.6), so that account moves by what KMyMoney
   * recorded. `stray` is an asset split on an activity that moves no cash.
   */
  private extraAssets(
    transaction: KmyTransaction,
    dissection: KmyDissection,
    stray: KmySplit | null = null,
  ): void {
    const splits = [...dissection.extraAssets, ...(stray ? [stray] : [])];
    const imported = splits.filter((split) =>
      this.context.mapping.keyById.has(split.account),
    );
    if (splits.length > 0) {
      this.warn("investmentExtraAssetSplit", transaction);
    }
    for (const split of imported) {
      this.cashCollector.rows.push(
        ordinaryRow(transaction, split, this.context, this.cashCollector),
      );
    }
  }

  private trade(
    transaction: KmyTransaction,
    d: KmyDissection,
    holding: Holding,
  ): void {
    const { context } = this;
    const commodity = transactionCommodity(transaction, context);

    // Amounts are in the transaction commodity; convert to the security's
    // trading currency at the file's own price, else leave them unconverted.
    const { rate, currency: securityCurrency } = this.conversion(
      transaction,
      holding,
      commodity,
    );
    const money = (value: Rational): number =>
      amountNumber(value, securityCurrency, context.coinDecimals);
    const convert = (value: Rational): Rational => mul(value, rate);

    const stock = d.stock;
    const asset = d.asset;
    const activity = d.activity;
    const shares = stock.shares;

    const amounts = tradeAmounts(d, convert, money);
    if (amounts === null) {
      this.cashOnly(transaction, d, "trade");
      return;
    }
    const { action, quantity, total, commission, price, withCash } = amounts;
    if (d.splitInMultiSplit) {
      this.warn("splitActionInMultiSplit", transaction);
    }
    const category =
      amounts.categorySplit === null
        ? null
        : this.categoryOf(amounts.categorySplit);
    const companions = amounts.companions.map((companion) => ({
      account: this.categoryOf(companion.split),
      amount: companion.amount,
    }));

    const cash = withCash
      ? planCash(this.context, transaction, d, asset)
      : NO_CASH;
    if (cash.fundedFromEquity) {
      this.warn("tradeFundedFromEquity", transaction);
    }
    const cashCurrency =
      (cash.key && context.mapping.currencyByKey.get(cash.key)) ||
      holding.pair.currencyCode;

    // Exchange rate: security currency to the cash account's currency.
    let exchangeRate = 1;
    if (
      cash.key !== null &&
      cash.shares !== null &&
      cashCurrency !== securityCurrency
    ) {
      const denominator =
        asset && !isZero(asset.value) ? abs(convert(asset.value)) : abs(total);
      exchangeRate = isZero(denominator)
        ? 1
        : rateNumber(div(abs(cash.shares), denominator));
    }
    const cashAmount =
      cash.key !== null && cash.shares !== null
        ? amountNumber(cash.shares, cashCurrency, context.coinDecimals)
        : 0;

    const payeeSplits = [
      stock,
      ...(asset ? [asset] : []),
      ...transaction.splits,
    ];
    const row: MappedInvestmentTransaction = {
      id: this.nextId(),
      handle: transaction.ordinal,
      accountKey: holding.pair.brokerageKey,
      cashAccountKey: cash.key,
      fundingAccountKey: cash.funding,
      cashTransactionId: null,
      transactionSplitId: null,
      securityHandle: holding.securityHandle,
      action,
      transactionDate: transaction.postDate as string,
      quantity,
      price,
      commission: money(commission),
      accruedInterest: 0,
      totalAmount: money(total),
      currencyCode: cashCurrency,
      securityCurrencyCode: securityCurrency,
      exchangeRate,
      cashAmount,
      status: statusOfSplit(asset ?? stock),
      payeeHandle: this.payeeOf(transaction, payeeSplits),
      categoryHandle: category,
      description:
        [stock.memo, asset?.memo ?? "", transaction.memo].find(
          (text) => text.trim() !== "",
        ) ?? null,
      linkedInvestmentId: null,
      tagHandles: this.collector.tagHandles(asset ? [stock, asset] : [stock]),
    };
    if (category !== null) {
      this.collector.categories.add(category);
    }

    const companionRows = companions.map(
      (companion): MappedInvestmentTransaction => ({
        ...row,
        id: this.nextId(),
        cashAccountKey: null,
        fundingAccountKey: null,
        action: InvestmentAction.INTEREST,
        quantity: null,
        price: money(companion.amount),
        commission: 0,
        totalAmount: money(companion.amount),
        currencyCode: holding.pair.currencyCode,
        securityCurrencyCode: securityCurrency,
        exchangeRate: 1,
        cashAmount: 0,
        categoryHandle: companion.account,
        linkedInvestmentId: row.id,
        tagHandles: [],
      }),
    );
    for (const companion of companionRows) {
      this.collector.categories.add(companion.categoryHandle as number);
    }
    this.rows.push(
      companionRows.length > 0
        ? { ...row, linkedInvestmentId: companionRows[0].id }
        : row,
      ...companionRows,
    );

    // Shapes that add rows beside the trade (spec 5.7.6).
    if (INCOME_ACTIVITIES.has(activity) && !isZero(shares)) {
      this.warn("investmentSharesOnIncomeAction", transaction);
      this.rows.push({
        ...row,
        id: this.nextId(),
        cashAccountKey: null,
        fundingAccountKey: null,
        action:
          sign(shares) >= 0
            ? InvestmentAction.ADD_SHARES
            : InvestmentAction.REMOVE_SHARES,
        quantity: quantityNumber(abs(shares)),
        price: null,
        commission: 0,
        totalAmount: 0,
        cashAmount: 0,
        exchangeRate: 1,
        categoryHandle: null,
        tagHandles: [],
        linkedInvestmentId: null,
      });
    }
    for (const extra of d.extraStocks) {
      this.extraStock(transaction, extra, row);
    }
    this.extraAssets(transaction, d, withCash ? null : asset);
  }

  /** Spec 5.7.6: a further stock split becomes added or removed shares in its own holding. */
  private extraStock(
    transaction: KmyTransaction,
    split: KmySplit,
    main: MappedInvestmentTransaction,
  ): void {
    this.warn("multipleStockSplits", transaction);
    const resolved = resolveHolding(this.context, split.account);
    if ("reason" in resolved || isZero(split.shares)) {
      return;
    }
    const { holding } = resolved;
    this.rows.push({
      ...main,
      id: this.nextId(),
      accountKey: holding.pair.brokerageKey,
      cashAccountKey: null,
      fundingAccountKey: null,
      securityHandle: holding.securityHandle,
      action:
        sign(split.shares) >= 0
          ? InvestmentAction.ADD_SHARES
          : InvestmentAction.REMOVE_SHARES,
      quantity: quantityNumber(abs(split.shares)),
      price: null,
      commission: 0,
      totalAmount: 0,
      cashAmount: 0,
      exchangeRate: 1,
      securityCurrencyCode: holding.securityCurrency,
      currencyCode: holding.pair.currencyCode,
      categoryHandle: null,
      tagHandles: [],
      linkedInvestmentId: null,
    });
  }

  private categoryOf(split: KmySplit): number {
    const account = this.context.tree.byId.get(split.account) as {
      ordinal: number;
      type: number;
    };
    return this.collector.category(account);
  }

  /** The first non-empty payee among `splits`, in the given order. */
  private payeeOf(
    transaction: KmyTransaction,
    splits: readonly KmySplit[],
  ): number | null {
    const id = splits.find((split) => split.payee)?.payee;
    if (!id) {
      return null;
    }
    const handle = this.context.payeeHandleById.get(id);
    if (handle === undefined) {
      this.warn("unknownPayeeReference", transaction, id);
      return null;
    }
    this.collector.payees.add(handle);
    return handle;
  }
}

export function mapKmyInvestments(
  context: KmyInvestmentContext,
  folded: ReadonlySet<number>,
): KmyInvestmentsResult {
  return runSteps(mapKmyInvestmentsSteps(context, folded));
}

/** `mapKmyInvestments` as steps (`kmy-steps.ts`): it yields every `STEP_EVERY` transactions. */
export function* mapKmyInvestmentsSteps(
  context: KmyInvestmentContext,
  folded: ReadonlySet<number>,
): Steps<KmyInvestmentsResult> {
  const mapper = new InvestmentMapper(context);
  const investing = context.raw.transactions.filter(
    (transaction) =>
      !folded.has(transaction.ordinal) && hasStockSplit(transaction, context),
  );
  yield;
  // KMyMoney's journal order (post date, then transaction id), so the row ids,
  // and with them the canonical replay's same-day tie-break, follow it (S1).
  // Undated transactions come last; they import nothing and are warned.
  const ordered = [
    ...journalOrder(investing),
    ...investing.filter((transaction) => !isIsoDate(transaction.postDate)),
  ];
  for (const [index, transaction] of ordered.entries()) {
    if (index % STEP_EVERY === STEP_EVERY - 1) {
      yield;
    }
    mapper.map(transaction);
  }

  const paired = pairShareTransfers(mapper.rows);
  const warnings: MnyWarning[] = [...mapper.warnings];
  const importedSplits = new Set(
    paired.transactions
      .filter((row) => row.action === InvestmentAction.SPLIT)
      .map((row) => row.handle as number),
  );
  warnings.push(
    ...checkStockSplits({
      raw: context.raw,
      tree: context.tree,
      securities: context.securities,
      context: warningContext(context),
      imported: importedSplits,
    }),
  );
  for (const row of paired.transactions) {
    if (row.action === InvestmentAction.ADD_SHARES) {
      warnings.push({
        code: "sharesAddedWithoutCost",
        subject: `transaction ${row.handle}`,
        row: warningRowForInvestment(row),
      });
    }
  }

  const transactions = orderForReplay(paired.transactions);
  const equityUsed = new Set([
    ...mapper.collector.equityUsed,
    ...mapper.cashCollector.equityUsed,
  ]);
  return {
    investments: {
      transactions,
      referencedSecurities: new Set(
        transactions.map((row) => row.securityHandle),
      ),
      referencedPayees: new Set(
        transactions
          .map((row) => row.payeeHandle)
          .filter((handle): handle is number => handle !== null),
      ),
      referencedCategories: new Set(
        transactions
          .map((row) => row.categoryHandle)
          .filter((handle): handle is number => handle !== null),
      ),
      transfersPaired: paired.paired,
      skipped: mapper.skipped,
      rateGaps: [],
      warnings: [...warnings, ...mapper.cashCollector.warnings],
    },
    cashRows: mapper.cashCollector.rows,
    cashReferences: {
      payees: mapper.cashCollector.payees,
      categories: mapper.cashCollector.categories,
      tags: new Set([...mapper.cashCollector.tags, ...mapper.collector.tags]),
    },
    equityUsed,
  };
}
