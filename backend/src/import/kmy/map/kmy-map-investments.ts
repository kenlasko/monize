import { randomUUID } from "node:crypto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  orderForReplay,
  pairShareTransfers,
} from "../../mny/map/map-investments";
import {
  MappedInvestmentTransaction,
  MappedInvestments,
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
import { hasStockSplit } from "./kmy-map-transactions";
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
import { checkStockSplits } from "./kmy-stock-splits";
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

class InvestmentMapper {
  readonly collector: RowCollector;
  readonly rows: MappedInvestmentTransaction[] = [];
  readonly cashCollector: RowCollector;
  readonly warnings: MnyWarning[] = [];
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
    this.trade(transaction, dissection, resolved.holding);
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
    const date = transaction.postDate as string;
    const commodity = transactionCommodity(transaction, context);

    // Amounts are in the transaction commodity; convert to the security's
    // trading currency at the file's own price, else leave them unconverted.
    let rate: Rational = ONE;
    let securityCurrency = holding.securityCurrency;
    if (commodity !== holding.securityCurrency) {
      const found = context.rateLookup(
        commodity,
        holding.securityCurrency,
        date,
      );
      if (found === null) {
        securityCurrency = commodity;
        this.warn(
          "crossCurrencyTradeUnconverted",
          transaction,
          `${commodity}->${holding.securityCurrency}`,
        );
      } else {
        rate = found;
      }
    }
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
      id: randomUUID(),
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
        id: randomUUID(),
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
        id: randomUUID(),
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
      id: randomUUID(),
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
  const mapper = new InvestmentMapper(context);
  for (const transaction of context.raw.transactions) {
    if (
      !folded.has(transaction.ordinal) &&
      hasStockSplit(transaction, context)
    ) {
      mapper.map(transaction);
    }
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
