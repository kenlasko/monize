import { InvestmentAction } from "./entities/investment-transaction.entity";

/**
 * The base action each Money-vocabulary refinement behaves as (issue #1149).
 *
 * A refinement moves shares and cash exactly like its base -- REINVEST_INTEREST
 * buys shares with money that never lands as cash, REDEEM is a disposal with
 * proceeds -- and differs only in the kind of income it records, which is what
 * tax reporting needs. Every financial fold (share replay, cash impact, cost
 * basis, balance effects) normalizes through `baseInvestmentAction` first, so a
 * refinement cannot drift from its base one switch at a time; only surfaces
 * that classify income read the raw action.
 */
const BASE_ACTION_BY_REFINEMENT: ReadonlyMap<
  InvestmentAction | string,
  InvestmentAction
> = new Map([
  [InvestmentAction.REINVEST_INTEREST, InvestmentAction.REINVEST],
  [InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT, InvestmentAction.REINVEST],
  [InvestmentAction.REINVEST_CAPITAL_GAIN_LONG, InvestmentAction.REINVEST],
  [InvestmentAction.CAPITAL_GAIN_SHORT, InvestmentAction.CAPITAL_GAIN],
  [InvestmentAction.CAPITAL_GAIN_LONG, InvestmentAction.CAPITAL_GAIN],
  [InvestmentAction.REDEEM, InvestmentAction.SELL],
]);

/**
 * The action whose financial behaviour governs `action` -- itself, unless it is
 * one of the Money-vocabulary refinements above.
 */
export function baseInvestmentAction(
  action: InvestmentAction | string,
): InvestmentAction | string {
  return BASE_ACTION_BY_REFINEMENT.get(action) ?? action;
}

/**
 * The order every ledger replay reads `investment_transactions` in.
 *
 * A position is a function of *economic* order, not of the order the rows were
 * entered in: a back-dated SELL entered after a later BUY still relieves basis
 * before that BUY blends in. `transaction_date` alone is not a total order --
 * rows written by one import or one split share `created_at` to the microsecond
 * -- so the primary key breaks the remaining tie and makes the replay a pure
 * function of the ledger's contents rather than of the plan PostgreSQL happened
 * to choose. Without the `id` leg two replays of the same unchanged ledger could
 * relieve basis in different orders and store two different average costs.
 *
 * Use this constant for a TypeORM `order`, and `INVESTMENT_REPLAY_ORDER_SQL`
 * for a raw `SELECT`, rather than restating the columns.
 */
export const INVESTMENT_REPLAY_ORDER = {
  transactionDate: "ASC",
  createdAt: "ASC",
  id: "ASC",
} as const;

/** `INVESTMENT_REPLAY_ORDER` spelled for a raw `ORDER BY`. */
export const INVESTMENT_REPLAY_ORDER_SQL =
  "transaction_date ASC, created_at ASC, id ASC";

/**
 * `rows` in replay order with the TRANSFER_OUT leg of a transfer ahead of its
 * TRANSFER_IN leg (A26-M21, A26-M22).
 *
 * Both legs of a transfer are written in one transaction, so `created_at` -- a
 * statement timestamp -- is identical on the pair and the SQL order between
 * them is whatever the plan happens to produce. The OUT leg has to be seen
 * first, because it is what tells the IN leg what the shares cost. Only the two
 * legs are reordered: the comparator returns 0 for everything else at the same
 * instant, and `sort` is stable, so nothing else moves. The input is not
 * modified.
 *
 * Every fold that hands a transferred-in lot the basis its source released
 * reads its rows through this, so the carry cannot depend on which leg the
 * database happened to return first.
 */
export function orderTransferOutBeforeIn<
  T extends {
    transactionDate: string;
    createdAt: Date;
    action: InvestmentAction | string;
  },
>(rows: readonly T[]): T[] {
  const legRank = (action: InvestmentAction | string): number =>
    action === InvestmentAction.TRANSFER_OUT
      ? -1
      : action === InvestmentAction.TRANSFER_IN
        ? 1
        : 0;
  return [...rows].sort((a, b) => {
    if (a.transactionDate !== b.transactionDate) {
      return a.transactionDate < b.transactionDate ? -1 : 1;
    }
    const created = Number(a.createdAt) - Number(b.createdAt);
    if (created !== 0) return created;
    return legRank(a.action) - legRank(b.action);
  });
}

/**
 * The canonical share-count effect of one investment action.
 *
 * Every surface that reconstructs a position from its transaction history --
 * the live holdings rebuild, the historical net-worth replay, the cost-basis
 * and capital-gains replays -- folds the same list of actions in the same
 * direction. Written out per call site the list drifts, and the drift is
 * invisible because each copy is internally consistent: three net-worth
 * reducers added a SPLIT's ratio to the share count (10 shares + a 2-for-1
 * ratio = 12) while the holdings service multiplied by it (= 20), so the same
 * position was worth 600 on the history chart and 1,000 on the holdings page.
 * The same three copies omitted ADD_SHARES and REMOVE_SHARES entirely, so
 * shares booked without a purchase never appeared in any historical chart.
 *
 * `quantity` means different things per action and that is the point of
 * centralizing it:
 * - BUY / REINVEST / TRANSFER_IN / ADD_SHARES -- shares acquired, added.
 * - SELL / TRANSFER_OUT / REMOVE_SHARES -- shares disposed of, subtracted.
 * - SPLIT -- a **ratio**, not a share count. The position is multiplied by it,
 *   which is what preserves total cost basis across a split. A 2-for-1 split
 *   carries `quantity = 2`; a 1-for-2 reverse split carries `0.5`.
 * - DIVIDEND / INTEREST / CAPITAL_GAIN / RETURN_OF_CAPITAL -- cash only, no
 *   share movement (a return of capital moves basis instead; see
 *   `applyReturnOfCapital`).
 *
 * A non-positive SPLIT ratio is not applied: it would zero or invert a real
 * position, and a row that cannot say what the split was is not evidence that
 * the shares went away.
 */
export function applyActionToQuantity(
  currentQuantity: number,
  action: InvestmentAction | string,
  quantity: number,
): number {
  switch (baseInvestmentAction(action)) {
    case InvestmentAction.BUY:
    case InvestmentAction.REINVEST:
    case InvestmentAction.TRANSFER_IN:
    case InvestmentAction.ADD_SHARES:
      return currentQuantity + quantity;
    case InvestmentAction.SELL:
    case InvestmentAction.TRANSFER_OUT:
    case InvestmentAction.REMOVE_SHARES:
      return currentQuantity - quantity;
    case InvestmentAction.SPLIT:
      return quantity > 0 ? currentQuantity * quantity : currentQuantity;
    default:
      // DIVIDEND / INTEREST / CAPITAL_GAIN / RETURN_OF_CAPITAL move cash, not
      // shares.
      return currentQuantity;
  }
}

/**
 * Actions that move shares, and therefore the ones a quantity replay must read.
 * A replay that filters its input by action list uses this rather than spelling
 * the list out, so a new action cannot be silently dropped from one surface.
 */
export const SHARE_MOVING_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
  InvestmentAction.TRANSFER_IN,
  InvestmentAction.TRANSFER_OUT,
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.SPLIT,
  // Money-vocabulary refinements that move shares, exactly as their base does.
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  InvestmentAction.REDEEM,
];

/**
 * Trades executed at a market price: the actions whose stored `price` can
 * stand in for a quote on a day the catalogue has none, and whose value moves
 * a portfolio's cash-flow series. TRANSFER_IN/OUT legs carry a carried cost
 * basis rather than the market price on the transfer date, so they are
 * deliberately absent. Raw-SQL readers pass this through `= ANY($n)` instead
 * of restating the list as string literals -- the restated copies are how the
 * Money refinements would silently fall out of the price-derivation and
 * net-worth queries.
 */
export const MARKET_PRICED_TRADE_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
  InvestmentAction.REINVEST_INTEREST,
  InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
  InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
  InvestmentAction.REDEEM,
];

/**
 * Actions whose `totalAmount` is cash income paid into the sleeve. The raw
 * value keeps the income kind (interest versus short- versus long-term gain);
 * the base collapses the kinds for surfaces that only need "income".
 */
export const CASH_INCOME_ACTIONS: readonly InvestmentAction[] = [
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.CAPITAL_GAIN_SHORT,
  InvestmentAction.CAPITAL_GAIN_LONG,
];

/**
 * The income each reinvestment records. A reinvest is a distribution paid in
 * shares rather than cash: it is income of the same kind as its cash twin (it
 * is on the 1099-DIV like one, and Money counted it as one), and it buys the
 * shares at the same moment, so no cash moves.
 *
 * Income surfaces count it through {@link incomeKind}. A formula whose market
 * value already holds the reinvested shares and whose base does not hold their
 * cost (a period return, net invested) reads `CASH_INCOME_ACTIONS` instead,
 * because adding the distribution there counts the same value twice.
 */
const INCOME_KIND_BY_REINVEST_ACTION: ReadonlyMap<
  InvestmentAction | string,
  InvestmentAction
> = new Map([
  [InvestmentAction.REINVEST, InvestmentAction.DIVIDEND],
  [InvestmentAction.REINVEST_INTEREST, InvestmentAction.INTEREST],
  [
    InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
    InvestmentAction.CAPITAL_GAIN_SHORT,
  ],
  [
    InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
    InvestmentAction.CAPITAL_GAIN_LONG,
  ],
]);

/** The actions that record a distribution paid in shares. */
export const REINVESTED_INCOME_ACTIONS: readonly InvestmentAction[] = [
  ...INCOME_KIND_BY_REINVEST_ACTION.keys(),
] as InvestmentAction[];

/**
 * The kind of income `action` records, as the cash-income action it equals
 * (DIVIDEND, INTEREST, CAPITAL_GAIN or a short/long refinement), or `null` for
 * an action that records none. `baseInvestmentAction` of the answer collapses
 * the kinds for a surface that only needs dividend / interest / capital gain.
 */
export function incomeKind(
  action: InvestmentAction | string,
): InvestmentAction | null {
  if (CASH_INCOME_ACTIONS.includes(action as InvestmentAction)) {
    return action as InvestmentAction;
  }
  return INCOME_KIND_BY_REINVEST_ACTION.get(action) ?? null;
}

/**
 * What a reinvested distribution came to, in the security's currency, unsigned.
 *
 * The stored total is the fact when the row has one -- an imported reinvest
 * keeps the file's amount, and some files carry no price beside it. A row
 * created in the app stores no total for a reinvest, so it is valued as its
 * shares entered the basis: quantity x price + commission (`acquisitionCost`
 * without a rate). Either way a gain measured as `value + income - cost` nets
 * the reinvestment to the distribution it was. `null` when the row carries
 * neither a total nor a price.
 */
export function reinvestedIncomeAmount(tx: {
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
  totalAmount?: number | string | null;
}): number | null {
  const total = Number(tx.totalAmount);
  if (Number.isFinite(total) && total !== 0) return Math.abs(total);
  return acquisitionCost(tx);
}

/**
 * The income one row records, in the security's currency: a cash distribution's
 * `totalAmount`, a reinvested one's {@link reinvestedIncomeAmount}, and 0 for a
 * row that records no income.
 *
 * A legacy reinvest with neither a total nor a price counts 0: the cost basis
 * leaves the same row out (`acquisitionCost` returns `null`), and a gain read
 * as `value + income - cost` stays consistent only if income leaves it out too.
 * A VOID row is the caller's to drop, as every total over these rows does.
 */
export function investmentIncomeAmount(tx: {
  action: InvestmentAction | string;
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
  totalAmount?: number | string | null;
}): number {
  if (CASH_INCOME_ACTIONS.includes(tx.action as InvestmentAction)) {
    return Number(tx.totalAmount) || 0;
  }
  if (INCOME_KIND_BY_REINVEST_ACTION.has(tx.action)) {
    return reinvestedIncomeAmount(tx) ?? 0;
  }
  return 0;
}

/**
 * What an action does to the INVESTED part of a portfolio -- the securities,
 * with the cash beside them left out.
 *
 * The invested part's P&L and time-weighted return
 * (`docs/specs/portfolio-period-result.md` section 10) need exactly this
 * classification, and it is the one list that decides it:
 *
 * - `capitalIn` -- value entering the invested part. Buying is not earning, so
 *   it must cancel out of the result and enter the base of the return.
 * - `capitalOut` -- value leaving it. Selling is not losing; the proceeds are
 *   what the position came to, and the cash they become earns nothing after.
 * - `income` -- cash the invested part paid out and therefore EARNED. It leaves
 *   as cash and stays in the result.
 * - `reinvestedIncome` -- REINVEST and its refinements: a distribution the
 *   invested part earned and put straight back into shares, the DIVIDEND and
 *   BUY it stands for in one row. A surface prints it in BOTH the income and
 *   the capital figure, so the result they add up to is unchanged; the return
 *   chains read neither, because its shares are already in the day's value and
 *   no value crossed the boundary.
 * - `none` -- SPLIT moves no value (it is a ratio).
 *
 * RETURN_OF_CAPITAL is `capitalOut`: the security pays back part of what was
 * invested in it, so value leaves the invested part as cash without being
 * earned -- the price falls by what was returned, and counting the cash as
 * income would report the same value as a gain it never was.
 *
 * Keyed by BASE action, so a Money-vocabulary refinement cannot fall out of the
 * classification by being forgotten here -- `investedFlowKind` normalizes
 * first. `investment-replay.util.spec.ts` holds every `InvestmentAction` member
 * to a kind, so a new action is a failing test rather than a silent zero in a
 * capital flow.
 */
export type InvestedFlowKind =
  "capitalIn" | "capitalOut" | "income" | "reinvestedIncome" | "none";

export const INVESTED_FLOW_KIND_BY_BASE_ACTION: ReadonlyMap<
  InvestmentAction,
  InvestedFlowKind
> = new Map([
  [InvestmentAction.BUY, "capitalIn" as const],
  [InvestmentAction.TRANSFER_IN, "capitalIn" as const],
  [InvestmentAction.ADD_SHARES, "capitalIn" as const],
  [InvestmentAction.SELL, "capitalOut" as const],
  [InvestmentAction.TRANSFER_OUT, "capitalOut" as const],
  [InvestmentAction.REMOVE_SHARES, "capitalOut" as const],
  [InvestmentAction.RETURN_OF_CAPITAL, "capitalOut" as const],
  [InvestmentAction.DIVIDEND, "income" as const],
  [InvestmentAction.INTEREST, "income" as const],
  [InvestmentAction.CAPITAL_GAIN, "income" as const],
  [InvestmentAction.REINVEST, "reinvestedIncome" as const],
  [InvestmentAction.SPLIT, "none" as const],
]);

/** What `action` does to the invested part; `none` for anything that moves no value. */
export function investedFlowKind(
  action: InvestmentAction | string,
): InvestedFlowKind {
  return (
    INVESTED_FLOW_KIND_BY_BASE_ACTION.get(
      baseInvestmentAction(action) as InvestmentAction,
    ) ?? "none"
  );
}

/**
 * The only actions allowed to use an explicit funding account: a BUY draws the
 * purchase cost from it, a SELL deposits the proceeds into it. Cash-bearing
 * DIVIDEND / INTEREST / CAPITAL_GAIN settle against the brokerage's linked cash
 * account; REINVEST and the share-only actions have no external cash leg at all.
 * So a funding account stored on any non-BUY/SELL action is stale and must never
 * route the money (issue #1154).
 *
 * Centralized so the scheduled-transaction service (which clears the column on
 * write and ignores it on post) and the MNY import writer (which must not
 * persist one on a non-funding action) share one authority rather than each
 * spelling out `{BUY, SELL}` and drifting apart.
 *
 * REDEEM is a sale in behaviour (`baseInvestmentAction`), so its proceeds
 * route to a funding account exactly as a SELL's do -- the transaction form
 * offers the field for it, and a set without it would silently clear what the
 * form stored.
 */
export const FUNDING_ACCOUNT_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REDEEM,
]);

/**
 * What a return of capital paid back, unsigned, or `null` when the row cannot
 * say.
 *
 * The stored total is in the security's currency. Given an `exchangeRate`, the
 * amount is converted with it, the same way `acquisitionCost` converts the
 * basis it is drawn against, so a replay in the settlement account's currency
 * subtracts like from like. A stored zero or negative rate is
 * absent-not-applicable, exactly as there: the reduction is unknown rather
 * than taken at par.
 */
export function returnOfCapitalAmount(tx: {
  totalAmount?: number | string | null;
  exchangeRate?: number | string | null;
}): number | null {
  const total = Math.abs(Number(tx.totalAmount));
  if (!Number.isFinite(total)) return null;
  const rate = tx.exchangeRate == null ? 1 : Number(tx.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return total * rate;
}

/** A position's basis after a return of capital, and the gain it realized. */
export interface ReturnOfCapitalEffect {
  /** The basis left, never below zero. */
  costBasis: number;
  /** How much of the basis the distribution paid back. */
  basisReturned: number;
  /**
   * What the distribution paid beyond the basis: a realized capital gain on
   * the distribution's date, because there was no cost left for it to return.
   */
  realizedGain: number;
}

/**
 * Apply a return of capital to a position's total cost basis.
 *
 * A return of capital is not income: it hands back part of what the shares
 * cost, so it comes off the basis and a later sale measures its gain against
 * what is left. The basis cannot go below zero -- a position cannot have cost
 * less than nothing -- so whatever exceeds it is a capital gain realized when
 * it was paid, which is how both the IRS (Publication 550, "Nondividend
 * Distributions") and the CRA (negative adjusted cost base) treat it. Every
 * replay that carries a basis folds the row through here, so the holdings
 * page, the realized-gain report and the capital-gains chart cannot disagree
 * about the same distribution. `docs/specs/return-of-capital.md`.
 */
export function applyReturnOfCapital(
  costBasis: number,
  amount: number,
): ReturnOfCapitalEffect {
  const basis = Math.max(costBasis, 0);
  const returned = Math.max(amount, 0);
  const basisReturned = Math.min(basis, returned);
  return {
    costBasis: basis - basisReturned,
    basisReturned,
    realizedGain: returned - basisReturned,
  };
}

/**
 * The basis a security-currency replay keeps after a return of capital row:
 * `applyReturnOfCapital` over the row's stored total, the row's rate not
 * applied. A row that cannot say what it paid leaves the basis as it was.
 */
export function basisAfterReturnOfCapital(
  costBasis: number,
  tx: { totalAmount?: number | string | null },
): number {
  const amount = returnOfCapitalAmount({ totalAmount: tx.totalAmount });
  return amount === null
    ? costBasis
    : applyReturnOfCapital(costBasis, amount).costBasis;
}

/**
 * Whether an action adds shares to a position without supplying a cost for
 * them. Basis-carrying replays must record that the basis they computed is
 * incomplete rather than treating the shares as free.
 */
export function isQuantityOnlyAction(
  action: InvestmentAction | string,
): boolean {
  return (
    action === InvestmentAction.ADD_SHARES ||
    action === InvestmentAction.REMOVE_SHARES
  );
}

/**
 * What an acquisition cost, in the currency the trade settled in.
 *
 * The commission belongs in the basis: it is part of what was paid to acquire
 * the position, and the linked cash debit already includes it. Leaving it out
 * understates the basis and so overstates every gain and every tax derived
 * from one -- 10 of commission on a 1,000 purchase is 10 of phantom gain.
 *
 * Returns `null` when the row cannot say what the acquisition cost: a missing
 * price is unknown, not free. A stored `0` is *no price* too, not a free
 * acquisition -- before the acquisition guard shipped, `create()` stored
 * `price ?? 0` and the form accepted a blank field, so real databases hold
 * zero-price BUY and REINVEST rows that mean "unknown". Replaying one as a
 * known zero-cost lot understates the basis and overstates every gain and tax
 * drawn from it, the same defect the null case closes arriving by a different
 * route. No legitimate zero can be stored from here on:
 * `assertAcquisitionPriced` refuses it, because a zero-cost purchase is not a
 * concept this application has.
 */
export function acquisitionCost(tx: {
  quantity?: number | string | null;
  price?: number | string | null;
  commission?: number | string | null;
  exchangeRate?: number | string | null;
  /**
   * The row's executed total, when the caller reads a stored row. It is what
   * the acquisition came to -- commission included, by the same convention
   * `deriveInvestmentTotal` writes it with -- and the price beside it is a
   * quotient of it, so `quantity * price + commission` reproduces it only to
   * within the price's rounding. Given, it is used; absent, the cost is built
   * from the price as it always was.
   */
  totalAmount?: number | string | null;
}): number | null {
  const quantity = Number(tx.quantity) || 0;
  const commission = Number(tx.commission) || 0;
  const hasPrice =
    tx.price !== null &&
    Number.isFinite(Number(tx.price)) &&
    Number(tx.price) > 0;

  if (!hasPrice && (quantity !== 0 || commission !== 0)) {
    return null;
  }

  const price = Number(tx.price) || 0;
  // An absent rate means the trade settled in its own currency (the entity
  // default is 1). A stored zero or negative rate is absent-not-applicable
  // (`AGENTS.md`: "Rate 1 means same currency, never no rate found"), so
  // the basis is unknown rather than converted at par -- `|| 1` here would
  // bake the silent 1:1 fallback into the one door every basis goes through.
  const rate = tx.exchangeRate == null ? 1 : Number(tx.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const total =
    tx.totalAmount === null || tx.totalAmount === undefined
      ? null
      : Number(tx.totalAmount);
  if (total !== null && Number.isFinite(total) && total !== 0) {
    return Math.abs(total) * rate;
  }
  return (quantity * price + commission) * rate;
}

/**
 * Below this many shares a replayed position is not a holding at all: the
 * stored quantity scale is 8 decimal places, so anything smaller is a rounding
 * residue of the fold rather than a share somebody owns.
 */
export const HOLDING_QUANTITY_EPSILON = 0.00000001;

/**
 * From this many shares up, a stored holding is a position the user holds:
 * the predicate the portfolio views apply (`|quantity| >= 0.0001`) before they
 * show or value a holding. Anything smaller is a residue the Investments page
 * never shows, so a check that refuses on a held position (closing an account)
 * uses this rather than "non-zero", or it refuses over shares nobody can see.
 */
export const HELD_QUANTITY_THRESHOLD = 0.0001;

/**
 * The `holdings` row a rebuild writes for a replayed position, or `null` when a
 * rebuild would store no row for it at all.
 *
 * Every rebuild writer projects the fold the same way -- drop the position when
 * the ledger accounts for no shares, and store `averageCost = 0` for a negative
 * (short) quantity, because the per-share basis of shares you do not hold is
 * not a number. The drift report compares the stored row against this rather
 * than against an idea of its own, so what it reports is exactly what a rebuild
 * would change.
 */
export function projectedHoldingRow(
  position: { quantity: number; totalCost: number } | undefined | null,
): { quantity: number; averageCost: number } | null {
  if (!position) return null;
  const { quantity, totalCost } = position;
  if (Math.abs(quantity) <= HOLDING_QUANTITY_EPSILON) return null;
  return { quantity, averageCost: quantity > 0 ? totalCost / quantity : 0 };
}
