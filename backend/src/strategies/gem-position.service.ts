import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney, sumMoney } from "../common/round.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import {
  PortfolioCalculationService,
  ReplayedLot,
} from "../securities/portfolio-calculation.service";
import { GemPriceService } from "./gem-price.service";
import { BOUNDARY_LAG_DAYS } from "./gem-momentum.util";
import {
  EMPTY_COMPOSITION,
  GemSecurityComposition,
  GemWeighting,
  overlapPercent,
} from "./gem-composition.util";
import {
  GemHolding,
  GemMatchedHolding,
  buildPositionMath,
  estimateCommission,
  estimateTax,
} from "./gem-position.util";
import {
  GemAccountRef,
  GemActionView,
  GemAssetRef,
  GemHeldAsset,
  GemPositionView,
} from "./gem-report.types";

export interface GemPositionResult {
  position: GemPositionView | null;
  action: GemActionView | null;
  /** True when the strategy has accounts but none of them holds anything. */
  noPosition: boolean;
  /**
   * How many of the strategy's accounts hold a position or cash, and so can
   * place an order. Zero when the accounts are all empty.
   *
   * The backtest sizes its per-leg commission on this rather than on the
   * number of accounts configured: an account with nothing in it places no
   * order, and charging one doubled the modelled cost of a strategy set up
   * across a funded account and an empty one.
   */
  tradingAccountCount: number;
}

/**
 * How old a stored exchange rate may be and still convert a reported figure.
 *
 * The same window the prices are held to, for the same reason: both are
 * observations of a market, and a total built from a fresh price and a stale
 * rate is no more knowable than one built from a stale price.
 */
const RATE_MAX_AGE_DAYS = BOUNDARY_LAG_DAYS;

/**
 * How far a replayed quantity may sit from the held one and still be the same
 * position. Matches the dust threshold the position arithmetic uses, so a
 * fractional residue left by a split is not read as a missing trade.
 */
const QUANTITY_TOLERANCE = 0.0001;

/** One security's holdings summed over the strategy's accounts. */
interface AggregatedHolding {
  securityId: string;
  symbol: string | null;
  name: string | null;
  quantity: number;
  /** Accounts this position is held in -- one sell order each. */
  accountIds: string[];
  /**
   * Units held in each of those accounts.
   *
   * Kept beside the sum because the sum cannot be reconciled against a replay:
   * 30 units too many in one account and 30 too few in another add up to a
   * total that agrees with the history while neither account does.
   */
  quantityByAccount: Map<string, number>;
  /** quantity * average cost, in the security's own currency; null when unknown. */
  costBasis: number | null;
  /** Currency the security is priced and costed in. */
  currencyCode: string;
  /** Set when a bond program prices the security: its value is its lots'. */
  bondProgramId: string | null;
  /** The breakdowns the security is described by, as stored. */
  composition: GemSecurityComposition;
}

/** One securities row's three breakdowns, in the shape the comparison wants. */
function toComposition(row: {
  country_weightings: GemWeighting[] | null;
  asset_weightings: GemWeighting[] | null;
  sector_weightings: Array<{ sector: string; weight: number }> | null;
}): GemSecurityComposition {
  return {
    COUNTRY: row.country_weightings ?? null,
    ASSET_CLASS: row.asset_weightings ?? null,
    // Sector rows key the name differently from the other two breakdowns.
    SECTOR:
      row.sector_weightings?.map((entry) => ({
        name: entry.sector,
        weight: entry.weight,
      })) ?? null,
  };
}

/**
 * Turns the strategy accounts' real holdings into the report's "your portfolio"
 * and "what should I do" blocks.
 *
 * A strategy can be run in several brokerage accounts at once -- the signal is
 * the same for all of them -- so holdings are summed per security across the
 * whole set and valued in the user's default currency, converting from each
 * security's own currency. The arithmetic lives in `gem-position.util`; this
 * class is the data access and the currency conversion around it.
 */
@Injectable()
export class GemPositionService {
  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
    private exchangeRateService: ExchangeRateService,
    private portfolioCalculation: PortfolioCalculationService,
  ) {}

  /**
   * Everything held in the strategy's accounts, summed per security across
   * them. Not filtered to the strategy's own instruments: GEM wants the whole
   * portfolio in one asset, so a holding the strategy never assigned is part of
   * what makes it non-compliant and part of what a switch has to sell.
   */
  private async loadHoldings(
    userId: string,
    accountIds: string[],
  ): Promise<AggregatedHolding[]> {
    if (accountIds.length === 0) return [];
    const rows: Array<{
      security_id: string;
      symbol: string | null;
      name: string | null;
      quantity: string;
      account_ids: string[];
      account_quantities: Record<string, string>;
      cost_basis: string | null;
      currency_code: string;
      bond_program_id: string | null;
      country_weightings: GemWeighting[] | null;
      asset_weightings: GemWeighting[] | null;
      sector_weightings: Array<{ sector: string; weight: number }> | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT h.security_id,
                s.symbol,
                s.name,
                SUM(h.quantity) AS quantity,
                -- Which accounts hold it. A switch places one order per
                -- account, not one per instrument: the same fund held in two
                -- brokerage accounts is two sells.
                array_agg(DISTINCT h.account_id) AS account_ids,
                -- And how much of it each one holds. The sum above cannot be
                -- reconciled against the replayed history: a surplus in one
                -- account cancels a shortfall in another and both bases pass.
                -- holdings is UNIQUE(account_id, security_id), so one entry per
                -- account; as text because a numeric in jsonb comes back as a
                -- JavaScript double.
                jsonb_object_agg(h.account_id::text, h.quantity::text)
                  AS account_quantities,
                -- A holding with no average cost makes the whole cost basis
                -- unknown rather than understated. SUM() skips NULL rows, so
                -- the CASE turns "one account is uncosted" into an unknown
                -- basis instead of a total that quietly omits it.
                CASE
                  WHEN bool_or(h.average_cost IS NULL) THEN NULL
                  ELSE SUM(h.quantity * h.average_cost)
                END AS cost_basis,
                s.currency_code,
                s.bond_program_id,
                -- The breakdowns the compliance comparison runs on: what a
                -- fund contains decides how much of it is already on target,
                -- not whether its ticker matches.
                s.country_weightings,
                s.asset_weightings,
                s.sector_weightings
           FROM holdings h
           JOIN securities s ON s.id = h.security_id
          WHERE h.account_id = ANY($1::uuid[])
            AND s.user_id = $2
            -- Rows the account no longer holds anything under. A full sale
            -- leaves the holding behind at quantity zero rather than deleting
            -- it, and an emptied account then survived into account_ids --
            -- where a switch counts it as an account to sell out of and buy
            -- into, at two commissions for a pair of orders nobody places. It
            -- also demanded a replayed lot for a position that is not there,
            -- which could take the whole cost basis to unknown.
            --
            -- Filtered per row and before the aggregates, so the account drops
            -- out of array_agg and jsonb_object_agg as well as out of the sum.
            -- A security emptied everywhere disappears entirely, which is the
            -- right answer: it is not held.
            AND ABS(h.quantity) >= $3
          GROUP BY h.security_id, s.symbol, s.name, s.currency_code, s.bond_program_id,
                   s.country_weightings, s.asset_weightings, s.sector_weightings`,
        [accountIds, userId, QUANTITY_TOLERANCE],
      ),
    );
    return rows.map((row) => ({
      securityId: row.security_id,
      symbol: row.symbol,
      name: row.name,
      quantity: Number(row.quantity),
      accountIds: row.account_ids ?? [],
      quantityByAccount: new Map(
        Object.entries(row.account_quantities ?? {}).map(
          ([accountId, quantity]) => [accountId, Number(quantity)] as const,
        ),
      ),
      costBasis: row.cost_basis === null ? null : Number(row.cost_basis),
      currencyCode: row.currency_code,
      bondProgramId: row.bond_program_id,
      composition: toComposition(row),
    }));
  }

  /**
   * Cash sitting in the strategy's accounts, per account, in each account's own
   * currency.
   *
   * Two shapes, because the app models brokerage accounts both ways: a
   * brokerage account paired with a linked `INVESTMENT_CASH` account holding
   * the balance, and a standalone investment account that carries its own. The
   * strategy picker offers the brokerage and standalone accounts (never the
   * cash half on its own), so the linked balances have to be found from the
   * chosen side -- and the link is stored from whichever account was created
   * second, hence both directions.
   *
   * Only a positive balance counts. A margin debit is money owed, not an asset
   * the switch can move, and treating it as off-target value would inflate the
   * purchase by the size of the debt.
   *
   * Investment accounts only. The picker offers nothing else, but the API takes
   * any account the user owns, and a chequing account attached to a strategy
   * must not quietly become money the report tells them to invest.
   */
  private async loadCash(
    userId: string,
    accountIds: string[],
  ): Promise<
    Array<{ accountId: string; amount: number; currencyCode: string }>
  > {
    if (accountIds.length === 0) return [];
    const rows: Array<{
      owner_account_id: string;
      current_balance: string;
      currency_code: string;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT
                -- The account the purchase is *placed on*, which is not always
                -- the row the balance sits on. A linked INVESTMENT_CASH account
                -- is a ledger, not somewhere you buy an ETF: reporting its own
                -- id counted an ordinary brokerage pair as two accounts and so
                -- charged two purchase commissions for one order.
                COALESCE(
                  CASE WHEN a.id = ANY($1::uuid[]) THEN a.id END,
                  CASE WHEN a.linked_account_id = ANY($1::uuid[])
                       THEN a.linked_account_id END,
                  (SELECT b.id
                     FROM accounts b
                    WHERE b.linked_account_id = a.id
                      AND b.id = ANY($1::uuid[])
                    LIMIT 1)
                ) AS owner_account_id,
                a.current_balance, a.currency_code
             FROM accounts a
            WHERE a.user_id = $2
              AND a.current_balance > 0
              AND a.account_type = 'INVESTMENT'
              AND (
                    -- A selected account that holds its own cash: either a
                    -- standalone investment account (no sub-type), or a
                    -- brokerage account with no linked cash half. The second
                    -- is reachable -- deleting the "- Cash" account of a pair
                    -- clears the survivor's link -- and findCashAccount
                    -- already treats it this way, so the balance really is the
                    -- cash ledger. Missing it made an account half in cash
                    -- read as 100% compliant with nothing to do.
                    (a.id = ANY($1::uuid[])
                     AND (a.account_sub_type IS NULL
                          OR (a.account_sub_type = 'INVESTMENT_BROKERAGE'
                              AND a.linked_account_id IS NULL)))
                 OR (a.account_sub_type = 'INVESTMENT_CASH'
                     AND (a.linked_account_id = ANY($1::uuid[])
                          OR a.id IN (SELECT b.linked_account_id
                                        FROM accounts b
                                       WHERE b.id = ANY($1::uuid[])
                                         AND b.linked_account_id IS NOT NULL)))
              )`,
        [accountIds, userId],
      ),
    );
    return rows.map((row) => ({
      accountId: row.owner_account_id,
      amount: Number(row.current_balance),
      currencyCode: row.currency_code,
    }));
  }

  /**
   * The breakdowns of one security that is not held -- the signal's target
   * usually is not, which is the whole point of the switch.
   *
   * Scoped by `user_id` as well as by id. The id reaching here comes from the
   * caller's own strategy, so today the filter changes no result; it is there
   * because at `RLS_MODE=off` the database enforces nothing, and the next
   * caller to pass an id from somewhere else should get no row rather than
   * another user's fund breakdown.
   */
  private async loadComposition(
    userId: string,
    securityId: string | null,
  ): Promise<GemSecurityComposition> {
    if (!securityId) return EMPTY_COMPOSITION;
    const rows: Array<{
      country_weightings: GemWeighting[] | null;
      asset_weightings: GemWeighting[] | null;
      sector_weightings: Array<{ sector: string; weight: number }> | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT country_weightings, asset_weightings, sector_weightings
           FROM securities
          WHERE id = $1 AND user_id = $2`,
        [securityId, userId],
      ),
    );
    return rows[0] ? toComposition(rows[0]) : EMPTY_COMPOSITION;
  }

  /**
   * Convert an amount from a security's currency into the report currency, or
   * null when no rate is available in either direction.
   *
   * Null rather than a rate of 1. A missing exchange rate is missing data
   * (`docs/financial-calculation-contract.md` sections 3 and 4), and passing
   * the foreign amount through unconverted does not degrade gracefully here:
   * every figure this report prints -- the total, the share held in the target
   * instrument, what a switch moves, the gain it realizes -- is a ratio or a
   * sum over these values, so one unconverted holding silently mis-states all
   * of them. The arithmetic in `gem-position.util` already turns a null value
   * into a null total, which is what the reader has to see.
   */
  private async convert(
    amount: number,
    from: string,
    to: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    if (!from || from === to) return amount;
    const key = `${from}->${to}`;
    if (!cache.has(key)) {
      // One lookup, which answers from either stored direction. This used to ask
      // twice and reciprocate the second answer itself -- a second copy of a
      // decision `resolveFxRate` owns, and copies are how resolvers drift.
      //
      // Bounded to the same fortnight as the prices these amounts are struck
      // from. An unbounded rate fails the way the unbounded price did, only
      // more quietly: nothing on the page is denominated in the rate, so a
      // nine-month-old one simply makes every converted figure wrong by the
      // year's currency move.
      cache.set(
        key,
        await this.exchangeRateService.getLatestRate(
          from,
          to,
          RATE_MAX_AGE_DAYS,
        ),
      );
    }
    const rate = cache.get(key) ?? null;
    return rate === null ? null : amount * rate;
  }

  /**
   * A holding's cost basis in the report currency, or null when it cannot be
   * established from what the transactions recorded.
   *
   * Five ways it stays unknown, and each is a real state rather than a
   * shortcut:
   *
   * - a lot with no average cost at all, which the holdings query already
   *   reports (an imported position nobody costed);
   * - an account whose books are in a currency other than the report's. The
   *   per-transaction rate translated the purchase into the *account's*
   *   currency, so a further conversion to the report currency would have to
   *   pick a rate for an aggregate spanning years -- there is no such rate,
   *   and today's is the wrong answer this method exists to avoid;
   * - a derived basis of zero, which for a position that is held means the
   *   transactions do not describe how it was acquired, not that it was free;
   * - **a replay that does not reproduce the position being valued.** An
   *   imported portfolio often carries the holding without every trade behind
   *   it, and a basis for 50 shares beside a market value for 100 is not a
   *   smaller basis, it is a basis for a different position. Reported as a
   *   gain it is mostly the cost of the shares nobody recorded: 100 shares
   *   worth 1,500 against a replayed 500 for half of them shows 1,000 of gain
   *   and 190 of tax where the truth is 500 and 95;
   * - a replay the lot itself reports as unpriced (`basisKnown: false`),
   *   which is what an `ADD_SHARES` or `REMOVE_SHARES` leaves behind, and
   *   equally an acquisition stored with no price at all;
   * - **a basis denominated in something else.** The replay converts each
   *   trade into the account that paid for it, which is the funding account
   *   or the brokerage's linked cash account -- not the brokerage. A PLN
   *   brokerage funded from a EUR account holds a EUR basis, and setting that
   *   against a PLN market value reports the exchange rate as profit.
   *
   * The units and the money are two separate questions, and this asks both.
   * The quantity check proves the history accounts for the units; it says
   * nothing about what they cost, because a quantity-only row reconciles
   * perfectly and prices nothing. Buy 50 at 10, then `ADD_SHARES` 50, and the
   * holding is 100 units against a replayed cost of 500 -- pass that as the
   * basis and the report claims 500 of gain and 95 of tax that nobody made.
   * `REMOVE_SHARES` runs the same error the other way: buy 100 at 10, remove
   * 50, and the replayed 1,000 against a stored 500 turns a real gain into a
   * loss. `ReplayedLot.basisKnown` is where that is decided; the comment on
   * `calculateCostBasisLotsInAccountCurrency` explains why the application
   * cannot answer it.
   *
   * The comparison is **per account**, not on the sum. Summed first, a holding
   * 30 units above its history in one account and 30 below in another
   * reconciles exactly, and both wrong bases are reported as the position's
   * cost.
   */
  private historicalCostBasis(params: {
    holding: AggregatedHolding;
    accountCostBases: Map<string, ReplayedLot>;
    currencyCode: string;
  }): number | null {
    const { holding, accountCostBases, currencyCode } = params;
    if (holding.costBasis === null) return null;
    let total = 0;
    for (const accountId of holding.accountIds) {
      const lot = accountCostBases.get(`${accountId}:${holding.securityId}`);
      if (lot === undefined || !lot.basisKnown) return null;
      // The lot's own currency, and only the lot's.
      //
      // The holding *account's* currency used to be checked here as well, and
      // it is not evidence about the basis: `exchangeRate` converts a trade
      // into whichever account paid for it, so a USD brokerage funded from a
      // PLN account holds a PLN basis that this rejected out of hand -- a
      // known cost reported as unknowable, and the gain and tax with it. Once
      // the lot states its own currency the account's is simply a different
      // fact about a different thing.
      //
      // A mismatch here is still unknown rather than converted: today's rate
      // would answer a question about today, and the acquisition happened at
      // its own.
      if (lot.currencyCode !== currencyCode) return null;
      const held = holding.quantityByAccount.get(accountId);
      if (held === undefined) return null;
      // The tolerance is the dust threshold the position arithmetic already
      // uses, so a fractional residue from a split does not invalidate an
      // otherwise complete history.
      if (Math.abs(lot.quantity - held) > QUANTITY_TOLERANCE) return null;
      total += lot.costBasis;
    }
    return total > 0 ? roundMoney(total) : null;
  }

  /** `convert` rounded to money, keeping the unknown state. */
  private async convertMoney(
    amount: number,
    from: string,
    to: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    const converted = await this.convert(amount, from, to, cache);
    return converted === null ? null : roundMoney(converted);
  }

  async build(params: {
    userId: string;
    strategy: GemStrategy;
    /** Accounts the strategy is run in; their holdings are summed. */
    accounts: GemAccountRef[];
    /** Role -> instrument, for every role including unmapped ones. */
    assetRefs: Map<GemAssetRole, GemAssetRef>;
    targetRole: GemAssetRole | null;
    /** Whether the current signal's operation was already marked executed. */
    executed: boolean;
    /** Currency the report reports money in (the user's default). */
    currencyCode: string;
  }): Promise<GemPositionResult> {
    const {
      userId,
      strategy,
      accounts,
      assetRefs,
      targetRole,
      executed,
      currencyCode,
    } = params;
    const target = targetRole ? (assetRefs.get(targetRole) ?? null) : null;

    if (accounts.length === 0) {
      return {
        position: null,
        action: null,
        noPosition: false,
        tradingAccountCount: 0,
      };
    }

    const securityByRole = new Map<GemAssetRole, string>();
    for (const [role, ref] of assetRefs) {
      if (ref.securityId) securityByRole.set(role, ref.securityId);
    }
    const roleBySecurity = new Map(
      [...securityByRole].map(([role, securityId]) => [securityId, role]),
    );
    const aggregated = await this.loadHoldings(
      userId,
      accounts.map((account) => account.id),
    );
    const prices = await this.priceService.latestPrices([
      ...new Set([
        ...securityByRole.values(),
        ...aggregated.map((holding) => holding.securityId),
      ]),
    ]);

    /**
     * Cost basis per (account, security), already translated at each
     * transaction's **own** exchange rate.
     *
     * The holdings table's `average_cost` is in the security's currency, and
     * converting that aggregate at today's rate answers a different question:
     * ten units bought at 100 USD when USD/PLN was 3.00 cost 3,000 PLN, and
     * re-converting the 1,000 USD at today's 4.00 says 4,000 PLN -- so an
     * unchanged foreign price reports a gain of exactly zero and a tax of
     * zero, when the truth is 1,000 PLN and 190 PLN. Historical cost needs
     * historical rates, which is what this already does when it walks the
     * transactions.
     */
    const accountCostBases =
      await this.portfolioCalculation.calculateCostBasisLotsInAccountCurrency(
        userId,
        accounts.map((account) => account.id),
      );
    const rateCache = new Map<string, number | null>();
    // A bond-linked position is worth its own accounts' lots: the program-wide
    // blend also averages in lots of accounts outside this strategy's set.
    const bondValues = await this.portfolioCalculation.valueBondHoldings(
      userId,
      aggregated.flatMap((holding) =>
        holding.bondProgramId
          ? [...holding.quantityByAccount].map(([accountId, quantity]) => ({
              id: `${accountId}:${holding.securityId}`,
              accountId,
              securityId: holding.securityId,
              quantity,
              security: { bondProgramId: holding.bondProgramId },
            }))
          : [],
      ),
      prices,
    );
    const valued: GemHolding[] = [];
    for (const holding of aggregated) {
      const role = roleBySecurity.get(holding.securityId) ?? null;
      const price = prices.get(holding.securityId);
      let nativeValue: number | null;
      if (holding.bondProgramId) {
        const own = [...holding.quantityByAccount.keys()].map((accountId) =>
          bondValues.get(`${accountId}:${holding.securityId}`),
        );
        nativeValue = own.every((v) => v)
          ? sumMoney(own.map((v) => v?.marketValue as number))
          : null;
      } else {
        nativeValue = price === undefined ? null : holding.quantity * price;
      }
      const marketValue =
        nativeValue === null
          ? null
          : await this.convertMoney(
              nativeValue,
              holding.currencyCode,
              currencyCode,
              rateCache,
            );
      const costBasis = this.historicalCostBasis({
        holding,
        accountCostBases,
        currencyCode,
      });
      valued.push({
        role,
        securityId: holding.securityId,
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        accountIds: holding.accountIds,
        marketValue,
        costBasis,
        composition: holding.composition,
      });
    }

    // Cash joins the comparison as one aggregated position. It is summed
    // rather than listed per account because the whole report sums across the
    // strategy's accounts, and a switch spends whatever is in them.
    const cashRows = await this.loadCash(
      userId,
      accounts.map((account) => account.id),
    );
    const cashAccountIds = [...new Set(cashRows.map((row) => row.accountId))];
    const cashAmounts = await Promise.all(
      // A zero balance is zero in every currency, so it needs no rate.
      cashRows
        .filter((row) => row.amount !== 0)
        .map((row) =>
          this.convertMoney(
            row.amount,
            row.currencyCode,
            currencyCode,
            rateCache,
          ),
        ),
    );
    // Cash is always "priced" (contract section 3) -- but a balance in a
    // currency with no rate to the report currency is still an unknown amount
    // of the report currency, and summing only the convertible balances would
    // report a subtotal as the cash position.
    const cashValue = cashAmounts.some((amount) => amount === null)
      ? null
      : sumMoney(cashAmounts as number[]);
    if (cashValue === null || cashValue > 0) {
      valued.push({
        role: null,
        securityId: null,
        symbol: null,
        name: null,
        // Cash has no unit count; the amount stands in so the dust filter and
        // the ordering treat it like any other position. Unknown reads as zero
        // units here; `buildPositionMath` keeps an unvalued cash row anyway,
        // because dropping it would hide the very balance it cannot value.
        quantity: cashValue ?? 0,
        // Cash is spent, not sold, so it places no sell order of its own. The
        // accounts it sits in still buy, and they are counted from the
        // securities plus this list.
        accountIds: cashAccountIds,
        marketValue: cashValue,
        // Cash is worth what it is worth: selling it realizes nothing. Unknown
        // value means unknown basis -- the two are the same number.
        costBasis: cashValue,
        isCash: true,
      });
    }

    /**
     * Accounts the strategy can actually place an order in today.
     *
     * A configured account holding nothing and carrying no cash trades
     * nothing: there is no position to sell out of and no money to buy with.
     * Counting every configured account instead -- which is what the backtest
     * was handed -- charged a commission per leg for orders nobody places,
     * doubling the modelled cost of a strategy set up across a funded account
     * and an empty one.
     *
     * Built here rather than at the call site because this is the only place
     * that has both halves at per-account resolution: the holdings rows are
     * already filtered for dust, and a cash row exists for every account
     * whether or not it holds a balance.
     *
     * It describes today, and a backtest runs over years in which the
     * allocation was different. Nothing reconstructs those, so this is an
     * approximation of the run's trading width and not a claim about what
     * historically happened.
     */
    const fundedAccountIds = new Set<string>([
      ...aggregated.flatMap((holding) => holding.accountIds),
      ...cashRows.filter((row) => row.amount !== 0).map((row) => row.accountId),
    ]);

    const math = buildPositionMath(valued, targetRole, {
      securityId: target?.securityId ?? null,
      composition: await this.loadComposition(
        userId,
        target?.securityId ?? null,
      ),
    });

    const held = (holding: GemMatchedHolding): GemHeldAsset => ({
      role: holding.role,
      isCash: holding.isCash === true,
      securityId: holding.securityId,
      symbol: holding.symbol,
      name: holding.name,
      // A balance has no unit count, and printing its amount in the quantity
      // column would read as shares.
      quantity: holding.isCash ? null : holding.quantity,
      marketValue: holding.marketValue,
      isTargetInstrument: holding.isTargetInstrument,
      matchPercent: overlapPercent(holding.overlap),
      matchIsFloor: holding.overlapIsFloor,
      matchedByInstrument: holding.matchedByInstrument,
      matchedMarkets: holding.matchedMarkets.map((market) => ({
        name: market.name,
        percent: overlapPercent(market.weight) as number,
      })),
    });

    const position: GemPositionView = {
      accounts,
      holdings: math.holdings.map(held),
      current: math.current ? held(math.current) : null,
      target,
      exactTargetPercent: math.exactTargetPercent,
      marketExposurePercent: math.marketExposurePercent,
      marketExposureAvailable: math.marketExposureAvailable,
      marketExposureIsFloor: math.marketExposureIsFloor,
      marketExposureDimension: math.marketExposureAvailable
        ? math.dimension
        : null,
      changeRequired: math.changeRequired,
      totalMarketValue: math.totalMarketValue,
      basis: math.basis,
      dimension: math.dimension,
      requiredDimension: math.requiredDimension,
      instrumentMatchedCount: math.instrumentMatchedCount,
      currencyCode,
    };

    const action: GemActionView = {
      required: math.changeRequired && target !== null,
      // Every position the switch sells, largest first. Cash is off target and
      // funds the purchase, but naming it here would ask for a trade nobody
      // places, so `sold` already leaves it out.
      sellPositions: math.sold.map(held),
      to: target,
      targetWeightPercent: 100,
      transferValue: math.transferValue,
      realizedGainLoss: math.realizedGainLoss,
      estimatedTax: estimateTax(math.realizedGainLoss, strategy.taxRatePercent),
      taxRatePercent: strategy.taxRatePercent,
      estimatedCommission: estimateCommission(
        strategy.commissionAmount,
        math.sellCount,
        math.buyCount,
      ),
      estimatedTradeCount: math.sellCount + math.buyCount,
      partialMatchCount: math.sold.filter(
        (holding) => (holding.overlap ?? 0) > 0,
      ).length,
      accounts,
      currencyCode,
      executed,
    };

    return {
      position,
      action,
      noPosition: math.holdings.length === 0,
      tradingAccountCount: fundedAccountIds.size,
    };
  }
}
