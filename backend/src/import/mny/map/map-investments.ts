import { randomUUID } from "node:crypto";
import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { baseInvestmentAction } from "../../../securities/investment-replay.util";
import {
  disposalCashAmount,
  proceedsExcludingAccruedInterest,
  supportsAccruedInterest,
} from "../../../securities/accrued-interest.util";
import { roundMoney, roundToDecimals } from "../../../common/round.util";
import { roundFxRate } from "../../../common/fx-entry.util";
import {
  DatedRate,
  FxObservationLookup,
  resolveFxRate,
} from "../../../common/time-series/fx-rate-resolver";
import { derivePriceFromTotal } from "../../../securities/investment-amount.util";
import {
  MappedAccounts,
  MappedInvestmentTransaction,
  MappedInvestments,
  MappedSecurities,
  MnyMarketRates,
  MnyRateGap,
} from "../model/mny-import-model";
import {
  billTemplateHandles,
  decodeReference,
  isRecurrenceTemplate,
  isUnpostedRow,
  mapTransactionStatus,
} from "../model/mny-model";
import {
  hasInvestmentDetail,
  isUnconfirmedInvestmentAction,
  mapInvestmentAction,
} from "../model/mny-actions";
import {
  MONEY99_STOCK_OPTION_ACTIONS,
  MnyFileFormat,
} from "../model/mny-money99";
import { MnyBill, MnyTransaction } from "../model/mny-rows";
import { MnyWarning, MnyWarningRow } from "../model/mny-warnings";
import { MnyInvestmentData } from "../tables/read-investments";
import { cashKeyByAccountKey } from "./map-reference";
import { transactionTagHandles } from "./map-classifications";
import { MnyTransactionData } from "../tables/read-transactions";
import { ExchangeRateRow } from "../writers/write-prices";

/**
 * `TRN` rows carrying a security, mapped onto Monize investment transactions.
 *
 * Every rule here answers a specific way PR #192 corrupted positions (issue 4 in
 * the design's assessment table):
 *
 * - **Driven from `TRN`, not `TRN_INV`.** A cash dividend (`act` 4) has no
 *   `TRN_INV` row at all, so iterating the detail table dropped every one of
 *   them. Investment rows are identified by carrying a security, never by their
 *   action code -- `act = 0` is BUY and is indistinguishable from a plain
 *   payment by code alone.
 * - **`act` 16 is REMOVE_SHARES, never SELL.** It closes lots without a sale, so
 *   mapping it to SELL both invented proceeds and corrupted average cost.
 * - **Quantity is always positive.** `TRN_INV.qty` is stored positive and
 *   direction comes only from the action; inferring it from a sign is what
 *   produced negative positions.
 * - **`SEC_SPLIT` is *not* applied to positions.** See `reportUnappliedSplits`:
 *   Money does not adjust its own share counts for those rows, and adjusting
 *   ours makes the import disagree with the file it came from.
 *
 * Nothing here touches the database, and no code is guessed: an action outside
 * the known set is skipped and counted, and an action whose meaning is inferred
 * or reported rather than measured here (`MNY_UNCONFIRMED_ACTIONS`) carries a
 * warning on every row it maps.
 */

/** Quantities are `decimal(20,8)`; ratios and share counts round to match. */
const QUANTITY_DECIMALS = 8;

/** Prices are `decimal(20,6)`. */
const PRICE_DECIMALS = 6;

/** Shares move and no money changes hands, so the transaction has no value. */
const ZERO_TOTAL_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
  InvestmentAction.SPLIT,
]);

/**
 * Actions that never touch the cash sleeve. A reinvested distribution has a
 * real value but the money buys shares without ever landing as cash, so it has
 * a total and no cash leg.
 */
const NO_CASH_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  ...ZERO_TOTAL_ACTIONS,
  InvestmentAction.REINVEST,
]);

/** Cash leaves the sleeve; every other cash-moving action pays into it. */
const CASH_OUT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
]);

export interface MapInvestmentsInput {
  readonly transactions: MnyTransactionData;
  readonly investments: MnyInvestmentData;
  readonly accounts: MappedAccounts;
  readonly securities: MappedSecurities;
  /** `BILL` rows, so their template transactions are not imported as postings. */
  readonly bills: readonly MnyBill[];
  /**
   * The file's canonical exchange-rate rows (`resolveExchangeRates`), used to
   * convert a trade of a security quoted in another currency than its account.
   */
  readonly exchangeRates: readonly ExchangeRateRow[];
  /**
   * Rates for the trades `exchangeRates` cannot convert, looked up outside the
   * file. Absent on a first read, which reports what it needs as `rateGaps`.
   */
  readonly marketRates?: MnyMarketRates;
}

interface Context {
  readonly input: MapInvestmentsInput;
  /** `TRN_INV.htrn` -> the detail row, when the file has one. */
  readonly detailByHandle: ReadonlyMap<number, MnyInvestmentDetailValues>;
  /** Brokerage account key -> the cash sleeve that takes its cash legs. */
  readonly cashKeyByAccountKey: ReadonlyMap<string, string>;
  /** Account keys that are brokerage sides, so shares land somewhere real. */
  readonly brokerageKeys: ReadonlySet<string>;
  /** The file's rate observations, for converting a foreign-quoted trade. */
  readonly fxLookup: FxObservationLookup;
  /** `rateKey` -> a market rate for exactly that pair and date. */
  readonly marketRateByKey: ReadonlyMap<string, number>;
  readonly rateGaps: MnyRateGap[];
  readonly warnings: MnyWarning[];
}

function rateKey(from: string, to: string, date: string): string {
  return `${from}->${to}|${date}`;
}

/**
 * The flagged-row context an investment warning carries, so the review step can
 * point at a transaction the user can find in Money rather than a bare `htrn`.
 */
function warningRow(
  row: MnyTransaction,
  input: MapInvestmentsInput,
): MnyWarningRow {
  return {
    handle: row.handle as number,
    accountKey:
      row.account === null
        ? null
        : (input.accounts.keyByHandle.get(row.account) ?? null),
    date: row.date,
    amount: row.amount,
    payeeHandle: row.payee,
    reference: decodeReference(row.reference),
    memo: row.memo,
  };
}

interface MnyInvestmentDetailValues {
  readonly price: number;
  readonly quantity: number;
  readonly commission: number;
  /** `TRN_INV.amtInt`: accrued interest, paid out with a redemption. */
  readonly interest: number;
}

/**
 * Replay order: by date, and by file order within a date. The holdings rebuild
 * orders the same way -- by date and then by insertion, since rows inserted in
 * one statement share a `created_at` -- so this is the order the positions will
 * be folded in after the write.
 */
function orderForReplay(
  transactions: readonly MappedInvestmentTransaction[],
): MappedInvestmentTransaction[] {
  return [...transactions].sort((a, b) =>
    a.transactionDate === b.transactionDate
      ? 0
      : a.transactionDate < b.transactionDate
        ? -1
        : 1,
  );
}

function indexDetails(
  investments: MnyInvestmentData,
): Map<number, MnyInvestmentDetailValues> {
  const byHandle = new Map<number, MnyInvestmentDetailValues>();
  for (const detail of investments.investmentDetails) {
    if (detail.transaction === null) {
      continue;
    }
    byHandle.set(detail.transaction, {
      price: detail.price,
      quantity: detail.quantity,
      commission: detail.commission,
      interest: detail.interest,
    });
  }
  return byHandle;
}

/**
 * The magnitude of the transaction.
 *
 * `TRN.amt` is Money's own figure and wins where it has one: recomputing from
 * quantity and price would disagree with what Money shows. On `act` 30 it is
 * the gross cash figure including accrued interest; on Money Plus's
 * SELL-shaped redemption variant it is proceeds and the split parent carries
 * the gross payout. The sign is discarded and taken from the action instead,
 * which is the same rule that governs quantity.
 *
 * Accrued interest included in the row amount is taken back out: it is income,
 * and a redemption's total is proceeds, which is what every realized-gain fold
 * measures against cost basis. It reaches the ledger as the linked INTEREST
 * companion instead.
 */
function totalAmountOf(
  row: MnyTransaction,
  action: InvestmentAction,
  quantity: number | null,
  price: number | null,
  commission: number,
  accruedInterest: number,
  rowAmountIncludesAccruedInterest: boolean,
): number {
  const base = baseInvestmentAction(action);
  if (ZERO_TOTAL_ACTIONS.has(base as InvestmentAction)) {
    return 0;
  }
  if (row.amount !== 0) {
    return rowAmountIncludesAccruedInterest
      ? proceedsExcludingAccruedInterest(Math.abs(row.amount), accruedInterest)
      : roundMoney(Math.abs(row.amount));
  }
  if (quantity === null || price === null) {
    return 0;
  }
  const gross = quantity * price;
  return roundMoney(
    base === InvestmentAction.SELL ? gross - commission : gross + commission,
  );
}

/** Signed impact on the cash sleeve. Direction comes from the action only. */
function cashAmountOf(
  action: InvestmentAction,
  totalAmount: number,
  accruedInterest: number,
): number {
  const base = baseInvestmentAction(action) as InvestmentAction;
  if (NO_CASH_ACTIONS.has(base) || totalAmount === 0) {
    return 0;
  }
  // The interest arrives with the proceeds, in one movement of money.
  const magnitude = disposalCashAmount(totalAmount, accruedInterest);
  return CASH_OUT_ACTIONS.has(base) ? -magnitude : magnitude;
}

function positiveOrNull(value: number, decimals: number): number | null {
  const rounded = roundToDecimals(Math.abs(value), decimals);
  return rounded > 0 ? rounded : null;
}

interface TradeFigures {
  readonly action: InvestmentAction;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
  readonly accruedInterest: number;
  readonly totalAmount: number;
}

interface ConvertedFigures extends Omit<TradeFigures, "action" | "quantity"> {
  readonly exchangeRate: number;
  readonly securityCurrencyCode: string;
}

/**
 * Puts a trade's figures in the security's currency.
 *
 * `TRN.amt` is in the account's currency, while the app reads an investment
 * row's price and total as the security's and its `exchange_rate` as security ->
 * cash account (INV-FX-002). For a security quoted in another currency than its
 * account the file's rate converts the total, and the price is derived from the
 * converted total (INV-TRADE-001). The file's own rate always wins; where it has
 * none, a market rate for the trade's date (`MnyMarketRates`) does, and a
 * warning names every trade converted that way. With neither, the figures stay
 * in the account's currency at rate 1 and a warning says so: 1 there means "no
 * rate found", which is the one reading the rule forbids staying silent about.
 */
function convertToSecurityCurrency(
  row: MnyTransaction,
  figures: TradeFigures,
  accountCurrency: string,
  context: Context,
): ConvertedFigures {
  const unconverted: ConvertedFigures = {
    price: figures.price,
    commission: figures.commission,
    accruedInterest: figures.accruedInterest,
    totalAmount: figures.totalAmount,
    exchangeRate: 1,
    securityCurrencyCode: accountCurrency,
  };
  const security = context.input.securities.byHandle.get(
    row.security as number,
  );
  const securityCurrency = security?.currencyCode ?? "";
  const hasMoney =
    figures.totalAmount > 0 ||
    figures.price !== null ||
    figures.commission > 0 ||
    figures.accruedInterest > 0;
  if (
    !securityCurrency ||
    !accountCurrency ||
    securityCurrency === accountCurrency ||
    !hasMoney
  ) {
    return unconverted;
  }

  const date = row.date as string;
  const resolution = resolveFxRate(
    securityCurrency,
    accountCurrency,
    date,
    context.fxLookup,
  );
  const subject = security?.symbol ?? `hsec=${row.security}`;
  const pair = `${securityCurrency}->${accountCurrency}`;
  const marketRate =
    resolution.status === "resolved"
      ? undefined
      : context.marketRateByKey.get(
          rateKey(securityCurrency, accountCurrency, date),
        );
  if (marketRate !== undefined) {
    context.warnings.push({
      code: "crossCurrencyTradeMarketRate",
      subject,
      detail: `${pair} on ${date}: ${marketRate}`,
      row: warningRow(row, context.input),
    });
  }
  const fileRate = resolution.status === "resolved" ? resolution.rate : null;
  const foundRate = fileRate ?? marketRate ?? null;
  if (foundRate === null) {
    context.rateGaps.push({
      from: securityCurrency,
      to: accountCurrency,
      date,
    });
    // A provider that did not answer is not the same as a rate that does not
    // exist: the first is worth trying again later.
    const unanswered =
      context.input.marketRates?.unanswered.has(pair) === true
        ? "; provider_unanswered"
        : "";
    context.warnings.push({
      code: "crossCurrencyTradeUnconverted",
      subject,
      detail: `${pair} on ${date}: ${resolution.reason}${unanswered}`,
      row: warningRow(row, context.input),
    });
    return unconverted;
  }

  const rate = roundFxRate(foundRate);
  const totalAmount = roundMoney(figures.totalAmount / rate);
  const commission = roundMoney(figures.commission / rate);
  const derived =
    figures.price === null
      ? null
      : derivePriceFromTotal({
          action: figures.action,
          totalAmount,
          quantity: figures.quantity,
          commission,
        });
  const derivedPrice =
    derived === null ? null : roundToDecimals(derived, PRICE_DECIMALS);
  return {
    price:
      figures.price === null
        ? null
        : derivedPrice !== null && derivedPrice > 0
          ? derivedPrice
          : roundToDecimals(figures.price / rate, PRICE_DECIMALS),
    commission,
    accruedInterest: roundMoney(figures.accruedInterest / rate),
    totalAmount,
    exchangeRate: rate,
    securityCurrencyCode: securityCurrency,
  };
}

/**
 * True for a Money 97-99 purchase that records an amount and no units: a CD,
 * which Money 99 buys by amount. Its `TRN_INV` row carries neither `qty` nor
 * `dPrice` (measured on the one in the Money 99 template file; it opens no
 * `LOT` either), and a CD in a real Money 99 file had no `TRN_INV` row at all.
 * Money 99 cannot record a share purchase without a quantity, so a purchase
 * with none is never a share purchase.
 *
 * Money Plus stores the same purchase as units of 1 (`sample-cd-redemption.mny`
 * buys its CD as 5,000 at 1), and that is the shape it imports as: without
 * units it would be a holding of nothing that cost the amount.
 */
function isPurchaseByAmount(
  row: MnyTransaction,
  action: InvestmentAction,
  quantity: number | null,
  price: number | null,
  format: MnyFileFormat,
): boolean {
  return (
    format === "jet3" &&
    action === InvestmentAction.BUY &&
    quantity === null &&
    price === null &&
    row.amount !== 0
  );
}

/**
 * Units of 1 for a purchase made by amount: the principal, which is the total
 * less the commission a BUY's total includes. Null when nothing is left.
 */
function unitsBoughtByAmount(
  totalAmount: number,
  commission: number,
): number | null {
  const principal = roundMoney(totalAmount - commission);
  return principal > 0 ? roundToDecimals(principal, QUANTITY_DECIMALS) : null;
}

function mapOne(
  row: MnyTransaction,
  accountKey: string,
  action: InvestmentAction,
  context: Context,
): MappedInvestmentTransaction[] {
  const handle = row.handle as number;
  const detail = context.detailByHandle.get(handle);
  const format = context.input.transactions.format;

  const quantity = detail
    ? positiveOrNull(detail.quantity, QUANTITY_DECIMALS)
    : null;
  const price = detail ? positiveOrNull(detail.price, PRICE_DECIMALS) : null;
  const commission = detail ? roundMoney(Math.abs(detail.commission)) : 0;
  const byAmount = isPurchaseByAmount(row, action, quantity, price, format);

  if (!detail && !byAmount && hasInvestmentDetail(row.action, format)) {
    // The cash figure on the TRN row is still real, so the row imports without
    // a share movement rather than being dropped or having one invented.
    context.warnings.push({
      code: "missingInvestmentDetail",
      subject: `htrn=${handle}`,
      detail: `act=${row.action}`,
      row: warningRow(row, context.input),
    });
  }

  const detailInterest = detail ? roundMoney(Math.abs(detail.interest)) : 0;
  // Money Plus can store a register activity displayed as "Redeem CD/Bond" as
  // SELL when its cash payout is split into principal and accrued interest.
  const mappedAction =
    action === InvestmentAction.SELL && detailInterest > 0
      ? InvestmentAction.REDEEM
      : action;
  const accruedInterest = supportsAccruedInterest(mappedAction)
    ? detailInterest
    : 0;
  const totalAmount = totalAmountOf(
    row,
    mappedAction,
    quantity,
    price,
    commission,
    accruedInterest,
    supportsAccruedInterest(action),
  );
  // The cash leg settles in the account's currency, so it is worked out from
  // the account-currency total before any conversion into the security's.
  const cashAmount = cashAmountOf(mappedAction, totalAmount, accruedInterest);
  const id = randomUUID();
  const currencyCode =
    context.input.accounts.currencyByHandle.get(row.account as number) ?? "";
  const converted = convertToSecurityCurrency(
    row,
    {
      action: mappedAction,
      quantity,
      price,
      commission,
      accruedInterest,
      totalAmount,
    },
    currencyCode,
    context,
  );
  const status = mapTransactionStatus(row.clearedStatus, row.flags);
  const companionId = accruedInterest > 0 ? randomUUID() : null;
  const units = byAmount
    ? unitsBoughtByAmount(converted.totalAmount, converted.commission)
    : null;

  const redemption: MappedInvestmentTransaction = {
    id,
    handle,
    accountKey,
    cashAccountKey:
      cashAmount === 0
        ? null
        : (context.cashKeyByAccountKey.get(accountKey) ?? null),
    // Both null here, and rewritten by `applyInvestmentCashSources` for the
    // trades Money paired with a banking row: this mapper runs before the
    // transaction mapper and cannot yet know which those are.
    fundingAccountKey: null,
    cashTransactionId: null,
    transactionSplitId: null,
    securityHandle: row.security as number,
    action: mappedAction,
    transactionDate: row.date as string,
    quantity: units ?? quantity,
    price: units === null ? converted.price : 1,
    commission: converted.commission,
    accruedInterest: converted.accruedInterest,
    totalAmount: converted.totalAmount,
    currencyCode,
    securityCurrencyCode: converted.securityCurrencyCode,
    // security -> cash account. 1 for a same-currency trade, which is every
    // trade whose security is quoted in its account's currency; a trade of a
    // foreign-quoted security carries the file's rate, and one with no rate
    // stays at 1 with a warning. An adopted funding row can still replace it.
    exchangeRate: converted.exchangeRate,
    cashAmount,
    status,
    payeeHandle: row.payee,
    categoryHandle: row.category,
    description: row.memo,
    linkedInvestmentId: companionId,
    tagHandles: transactionTagHandles(row),
  };

  if (companionId === null) {
    return [redemption];
  }

  return [
    redemption,
    {
      ...redemption,
      id: companionId,
      // No handle: the companion is not a `TRN` row, so nothing may adopt a
      // banking row on its behalf (`applyInvestmentCashSources` keys on it).
      handle: null,
      action: InvestmentAction.INTEREST,
      quantity: null,
      price: converted.accruedInterest,
      commission: 0,
      accruedInterest: 0,
      totalAmount: converted.accruedInterest,
      // The redemption's own cash row carries the interest already.
      cashAccountKey: null,
      cashAmount: 0,
      linkedInvestmentId: id,
    },
  ];
}

/**
 * Turns matching `act` 15 / `act` 16 rows into a linked TRANSFER_IN /
 * TRANSFER_OUT pair.
 *
 * Money records a security moving between accounts as two independent rows: an
 * ADD_SHARES in the destination and a REMOVE_SHARES in the source, with nothing
 * connecting them. They are the same event, so they are matched on date,
 * security and quantity across two different accounts.
 *
 * An unpaired row stays ADD/REMOVE_SHARES and produces **no warning**: that is
 * exactly what Money recorded and the position it produces is identical either
 * way. Opening a portfolio with shares transferred in from a broker is the
 * ordinary case, not an anomaly -- `money2002.mny` alone has 60 of them, which
 * is 60 lines of noise burying the warnings that do mean something.
 */
export function pairShareTransfers(
  transactions: readonly MappedInvestmentTransaction[],
): { transactions: MappedInvestmentTransaction[]; paired: number } {
  const key = (transaction: MappedInvestmentTransaction): string =>
    `${transaction.transactionDate}|${transaction.securityHandle}|${transaction.quantity ?? 0}`;

  const removals = new Map<string, MappedInvestmentTransaction[]>();
  for (const transaction of transactions) {
    if (transaction.action !== InvestmentAction.REMOVE_SHARES) {
      continue;
    }
    const bucket = removals.get(key(transaction)) ?? [];
    removals.set(key(transaction), [...bucket, transaction]);
  }

  /** id -> the id it links to, and the action it becomes. */
  const rewrites = new Map<
    string,
    { action: InvestmentAction; linkedInvestmentId: string }
  >();
  const claimed = new Set<string>();
  let paired = 0;

  for (const addition of transactions) {
    if (
      addition.action !== InvestmentAction.ADD_SHARES ||
      addition.quantity === null
    ) {
      continue;
    }
    const partner = (removals.get(key(addition)) ?? []).find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.accountKey !== addition.accountKey,
    );
    if (!partner) {
      continue;
    }

    claimed.add(partner.id);
    claimed.add(addition.id);
    rewrites.set(addition.id, {
      action: InvestmentAction.TRANSFER_IN,
      linkedInvestmentId: partner.id,
    });
    rewrites.set(partner.id, {
      action: InvestmentAction.TRANSFER_OUT,
      linkedInvestmentId: addition.id,
    });
    paired += 1;
  }

  const rewritten = transactions.map((transaction) => {
    const rewrite = rewrites.get(transaction.id);
    return rewrite
      ? {
          ...transaction,
          action: rewrite.action,
          linkedInvestmentId: rewrite.linkedInvestmentId,
        }
      : transaction;
  });

  return { transactions: rewritten, paired };
}

/**
 * Reports the `SEC_SPLIT` rows the file records, without applying any of them.
 *
 * The importer used to synthesize a SPLIT transaction per holder, on the design's
 * premise that ignoring a split leaves every later position wrong by its ratio.
 * **Money does not adjust its own share counts for these rows**, so applying them
 * makes the import disagree with the file. Two files say so, at seven positions,
 * with no counter-example:
 *
 * - The maintainer's brokerage held 200 VTI bought pre-`SEC_SPLIT` plus 100
 *   after, and transferred the account away with a single 300-share row. Money's
 *   `LOT` rows for both purchases are fully consumed by that transfer; applying
 *   the 1:2 ratio leaves 200 shares in an account Money shows as empty. XIU
 *   (1:4), XIC (1:4) and VWO (1:2) each do the same thing.
 * - Money Plus's own `sample.mny` agrees: `LOT` holds 3 MSFT against 6 replayed
 *   with the 1:2 split, 50 LEH against 1,225, and 110.25 ADM against 115.7625.
 *
 * The price series makes the reason visible. A split's `SP` row carries
 * `dPrice = 0` and `src = 0` -- a marker in the quote history, not a quote -- and
 * the prices either side of it are continuous, in the same units as the
 * transactions. `SEC_SPLIT` is quote-feed metadata: it turns up for securities
 * the user never held, and for the annual 1:1 "splits" Canadian ETFs record
 * against a reinvested distribution.
 *
 * So the rows are surfaced rather than acted on, and only when they could have
 * mattered: a ratio of exactly 1 changes no position, and a security the import
 * left behind has no position to change.
 *
 * A Money 97-99 file is not surfaced at all, because there the reason is
 * measured rather than inferred: recording a split rewrites the trades before
 * it. Two copies of the same Money 99 file, before and after a 1:2 AMZN split
 * was recorded, differ by exactly that -- every AMZN `TRN_INV.qty` and
 * `LOT.qty` doubled, every `TRN_INV.dPrice` and quote halved, the other
 * securities untouched. The positions read from the file already include the
 * split, so a warning would only send the user to check a correct number.
 */
function reportUnappliedSplits(context: Context): void {
  if (context.input.transactions.format === "jet3") {
    return;
  }
  const { securitySplits, splitSecurities } = context.input.investments;

  for (const split of securitySplits) {
    if (split.handle === null) {
      continue;
    }
    const securityHandle = splitSecurities.get(split.handle) ?? null;
    const security =
      securityHandle === null
        ? undefined
        : context.input.securities.byHandle.get(securityHandle);
    const ratio =
      split.sharesBefore > 0 ? split.sharesAfter / split.sharesBefore : 0;

    if (
      security === undefined ||
      split.recordDate === null ||
      !Number.isFinite(ratio) ||
      ratio <= 0 ||
      ratio === 1
    ) {
      continue;
    }

    context.warnings.push({
      code: "securitySplitNotApplied",
      subject: security.symbol,
      detail: `${split.recordDate}: ${split.sharesBefore} -> ${split.sharesAfter}`,
    });
  }
}

/** The canonical rows as the resolver reads them, keyed `from->to`. */
function fxLookupOf(rows: readonly ExchangeRateRow[]): FxObservationLookup {
  const byPair = new Map<string, DatedRate[]>();
  for (const row of rows) {
    const key = `${row.fromCurrency}->${row.toCurrency}`;
    const observations = byPair.get(key);
    const observation = { date: row.rateDate, rate: row.rate };
    if (observations === undefined) {
      byPair.set(key, [observation]);
    } else {
      // Appended in place: a Money file can carry years of daily rates per
      // pair, and copying the array per row would be quadratic in them.
      observations.push(observation);
    }
  }
  return (from, to) => byPair.get(`${from}->${to}`);
}

function buildContext(input: MapInvestmentsInput): Context {
  const brokerageKeys = new Set<string>();
  for (const account of input.accounts.accounts) {
    if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE) {
      brokerageKeys.add(account.key);
    }
  }

  return {
    input,
    detailByHandle: indexDetails(input.investments),
    // Shared with the transaction mapper, which routes transfers into the same
    // sleeve this puts trade cash legs in.
    cashKeyByAccountKey: cashKeyByAccountKey(input.accounts),
    brokerageKeys,
    fxLookup: fxLookupOf(input.exchangeRates),
    marketRateByKey: new Map(
      (input.marketRates?.rates ?? []).map((market) => [
        rateKey(market.from, market.to, market.date),
        market.rate,
      ]),
    ),
    rateGaps: [],
    warnings: [],
  };
}

export function mapInvestments(input: MapInvestmentsInput): MappedInvestments {
  const context = buildContext(input);
  const warnings = context.warnings;
  const templates = billTemplateHandles(
    input.bills,
    input.transactions.transactions,
  );
  const splitChildren = new Set(
    input.transactions.splits
      .map((split) => split.child)
      .filter((child): child is number => child !== null),
  );

  const mapped: MappedInvestmentTransaction[] = [];
  let skipped = 0;

  for (const row of input.transactions.transactions) {
    if (
      row.handle === null ||
      row.security === null ||
      splitChildren.has(row.handle) ||
      templates.has(row.handle) ||
      isRecurrenceTemplate(row.frequency) ||
      isUnpostedRow(row.flags)
    ) {
      continue;
    }

    const accountKey =
      row.account === null
        ? null
        : (input.accounts.keyByHandle.get(row.account) ?? null);
    if (accountKey === null) {
      // The account was left out of the import: a choice, not a data problem.
      continue;
    }

    if (row.date === null) {
      skipped += 1;
      warnings.push({
        code: "unusableTransaction",
        subject: `htrn=${row.handle}`,
        detail: "no usable date",
        row: warningRow(row, input),
      });
      continue;
    }

    if (!input.securities.byHandle.has(row.security)) {
      // A currency pseudo-security, or a SEC row with no usable identity.
      skipped += 1;
      warnings.push({
        code: "missingInvestmentDetail",
        subject: `htrn=${row.handle}`,
        detail: `hsec=${row.security}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (!context.brokerageKeys.has(accountKey)) {
      skipped += 1;
      warnings.push({
        code: "investmentAccountMismatch",
        subject: `htrn=${row.handle}`,
        detail: accountKey,
        row: warningRow(row, input),
      });
      continue;
    }

    const format = input.transactions.format;
    if (format === "jet3" && MONEY99_STOCK_OPTION_ACTIONS.has(row.action)) {
      // An option grant, vesting or expiry moves no cash and no shares, and
      // Monize has no model for an unexercised option.
      skipped += 1;
      warnings.push({
        code: "stockOptionNotImported",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
        row: warningRow(row, input),
      });
      continue;
    }

    const action = mapInvestmentAction(row.action, format);
    if (action === null) {
      skipped += 1;
      warnings.push({
        code: "unknownInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
        row: warningRow(row, input),
      });
      continue;
    }

    if (isUnconfirmedInvestmentAction(row.action, format)) {
      warnings.push({
        code: "unconfirmedInvestmentAction",
        subject: `htrn=${row.handle}`,
        detail: `act=${row.action}`,
        row: warningRow(row, input),
      });
    }

    mapped.push(...mapOne(row, accountKey, action, context));
  }

  const paired = pairShareTransfers(mapped);
  reportUnappliedSplits(context);
  const transactions = orderForReplay(paired.transactions);

  return {
    transactions,
    referencedSecurities: new Set(
      transactions.map((transaction) => transaction.securityHandle),
    ),
    referencedPayees: new Set(
      transactions
        .map((transaction) => transaction.payeeHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    referencedCategories: new Set(
      transactions
        .map((transaction) => transaction.categoryHandle)
        .filter((handle): handle is number => handle !== null),
    ),
    transfersPaired: paired.paired,
    skipped,
    rateGaps: context.rateGaps,
    warnings,
  };
}
