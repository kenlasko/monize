import { Injectable } from "@nestjs/common";
import { roundMoney, roundToDecimals, sumMoney } from "../common/round.util";
import { Security } from "./entities/security.entity";
import { InvestmentAction } from "./entities/investment-transaction.entity";
import {
  acquisitionCost,
  baseInvestmentAction,
  investmentIncomeAmount,
} from "./investment-replay.util";
import { investmentRowHasEffect } from "./investment-row-effects.util";
import { SecuritiesService } from "./securities.service";
import { DailyPriceChange } from "./daily-change.util";
import { PortfolioService } from "./portfolio.service";
import {
  InvestmentTransactionsService,
  SecurityHistoryTransaction,
} from "./investment-transactions.service";

/**
 * The position in one account holding this security.
 *
 * Every monetary field is in the **security's own currency** -- the currency its
 * price and average cost are quoted in -- except `costBasisAccountCurrency`,
 * which is the portfolio's historical-rate conversion and is named for it. This
 * service deliberately converts nothing itself: FX belongs to the portfolio
 * calculation, and a second conversion path here produced figures that
 * disagreed with the Portfolio page and, worse, a gain whose amount and
 * percentage could carry opposite signs.
 */
export interface SecurityDetailAccountPosition {
  accountId: string;
  accountName: string;
  accountCurrencyCode: string | null;
  /** True for a position still held in an account the user has closed. */
  isClosed: boolean;
  /** Exact share balance, un-snapped, as the transaction history reports it. */
  quantity: number;
  /** Average cost per unit, in the security's currency. */
  averageCost: number | null;
  /** Cost basis in the security's currency. */
  costBasis: number | null;
  /**
   * Cost basis in the account's currency, from the historical rates on the buy
   * legs. Taken verbatim from the portfolio calculation, so it matches what the
   * Portfolio page shows.
   */
  costBasisAccountCurrency: number | null;
  /** Market value in the security's currency; null when it cannot be known. */
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

/**
 * The aggregate position across every account, for the summary cards. All
 * amounts are in the security's currency, so they add up without conversion.
 */
export interface SecurityDetailPosition {
  /** Exact total share balance, including any held in closed accounts. */
  quantity: number;
  /** Quantity-weighted average cost per unit, in the security's currency. */
  averageCost: number | null;
  currentPrice: number | null;
  costBasis: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
}

/**
 * Lifetime activity totals for the Position info card. Amounts are in the
 * security's currency, matching how the transaction table renders each row --
 * except `realizedGain`, which the canonical replay denominates in the holding
 * account's currency and which therefore travels with its own currency code.
 */
export interface SecurityDetailActivity {
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  /** Cost of every acquiring leg (buys, reinvestments, transfers in). */
  /** Null when an acquiring or transferring row has no price to state its cost. */
  totalInvested: number | null;
  /** Cash taken out on SELL legs, commission deducted. */
  totalSold: number;
  /** Dividends, interest and distributed capital gains received. */
  dividends: number;
  /** Commission across every leg. */
  fees: number;
  /**
   * Realized gain from the average-cost replay, this security only, in
   * `realizedGainCurrency`. Null when the security was sold from accounts of
   * more than one currency: those gains are not addable, and their raw sum
   * would be a number in no currency at all.
   */
  realizedGain: number | null;
  /**
   * False when a sale drew on shares of unknown cost, so its gain is unknown
   * and `realizedGain` is null although the sales sit in one currency.
   */
  realizedGainComplete: boolean;
  /** The gains that are known, when `realizedGainComplete` is false. */
  realizedGainKnownSubtotal: number | null;
  realizedGainCurrency: string | null;
  /**
   * Distinct account currencies the security was sold from, for naming them
   * when the gains cannot be added up. Excludes sales from an account with no
   * currency code, so read it together with `realizedSaleCount` rather than as
   * a count of sales.
   */
  realizedGainCurrencies: string[];
  /**
   * How many sales the replay found. This is what tells the two reasons
   * `realizedGain` is null apart: zero means the security was never sold, and
   * anything else means the gains exist but span currencies. Without it the UI
   * showed one blank row for both, which are very different statements.
   */
  realizedSaleCount: number;
  transactionCount: number;
}

export interface SecurityDetail {
  security: Security;
  position: SecurityDetailPosition;
  accounts: SecurityDetailAccountPosition[];
  activity: SecurityDetailActivity;
  /** False for a security that has never been transacted. */
  hasTransactions: boolean;
  /** True when the security was held and has since been sold down to nothing. */
  isPositionClosed: boolean;
  /** The security's daily move (`resolveDailyPriceChange`); null when refused. */
  dailyChange: DailyPriceChange | null;
}

/**
 * Decimal places a per-unit price carries, matching the NUMERIC(24,10) columns
 * prices are stored in (migration 116). Money totals round to 4; a price per
 * unit must not, or a sub-cent instrument loses a percentage of its value.
 */
const UNIT_PRICE_DECIMALS = 10;

/** One realized-gain entry, narrowed to the fields this service reads. */
interface RealizedGainRow {
  securityId: string;
  realizedGain: number | null;
  accountCurrencyCode: string | null;
}

/**
 * Actions that acquire shares, and so contribute to what was invested. Mirrors
 * the set the canonical average-cost replay adds to cost basis, so "total
 * invested" cannot read 0.00 beside a non-zero cost basis on the same card.
 */
const ACQUIRING_ACTIONS: ReadonlySet<InvestmentAction> = new Set([
  InvestmentAction.BUY,
  InvestmentAction.REINVEST,
  InvestmentAction.TRANSFER_IN,
]);

/**
 * Everything the security detail page needs beyond the security row itself:
 * the position (aggregate and per account), and the lifetime activity totals.
 *
 * Deliberately a composition of existing services rather than new arithmetic.
 * Cost basis, market value and realized gain are the portfolio's own numbers --
 * recomputing them here would let this page drift from the Portfolio and
 * Reports screens, which is exactly the class of bug the "shared logic lives on
 * the domain service" rule exists to prevent.
 *
 * Which accounts hold the security, and how much, comes from the transaction
 * history rather than from the portfolio summary. The summary is built from open
 * accounts only and drops residuals under 0.0001, so trusting it for existence
 * would report a position still held in a closed account -- or a dust holding
 * that the history view exists to help track down -- as "position closed".
 */
@Injectable()
export class SecurityDetailService {
  constructor(
    private readonly securitiesService: SecuritiesService,
    private readonly portfolioService: PortfolioService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
  ) {}

  async getDetail(userId: string, securityId: string): Promise<SecurityDetail> {
    // Validates ownership and existence, and works for inactive securities.
    const security = await this.securitiesService.findOne(userId, securityId);

    const history =
      await this.investmentTransactionsService.getSecurityTransactionHistory(
        userId,
        securityId,
      );

    // The whole-portfolio summary is the only place cost basis and market value
    // are computed canonically, so those are filtered out of it rather than
    // recalculated. It costs more work than a single-security query would, but
    // it guarantees the figures here match the Portfolio page.
    const summary = await this.portfolioService.getPortfolioSummary(userId);
    const holdingByAccountId = new Map(
      summary.holdingsByAccount.flatMap((group) => {
        const holding = group.holdings.find((h) => h.securityId === securityId);
        return holding
          ? ([
              [
                group.accountId,
                { holding, accountCurrencyCode: group.currencyCode },
              ],
            ] as const)
          : [];
      }),
    );

    const accounts: SecurityDetailAccountPosition[] = history.accounts
      // An account that traded the security but holds none of it now belongs to
      // the transaction history, not to a table of current positions.
      .filter((account) => account.currentQuantity !== 0)
      .map((account) => {
        const enriched = holdingByAccountId.get(account.accountId);
        const holding = enriched?.holding;
        return {
          accountId: account.accountId,
          accountName: account.accountName,
          accountCurrencyCode: enriched?.accountCurrencyCode ?? null,
          isClosed: account.isClosed,
          quantity: account.currentQuantity,
          averageCost: holding?.averageCost ?? null,
          costBasis:
            holding === undefined ? null : roundMoney(holding.costBasis),
          costBasisAccountCurrency:
            holding?.costBasisAccountCurrency == null
              ? null
              : roundMoney(holding.costBasisAccountCurrency),
          marketValue:
            holding?.marketValue == null
              ? null
              : roundMoney(holding.marketValue),
          gainLoss:
            holding?.gainLoss == null ? null : roundMoney(holding.gainLoss),
          gainLossPercent: holding?.gainLossPercent ?? null,
        };
      });

    const realizedGains = await this.loadRealizedGains(
      userId,
      history.accounts.map((account) => account.accountId),
    );

    return {
      security,
      position: this.buildAggregatePosition(
        accounts,
        history.currentQuantityAll,
        summary.holdings.find((h) => h.securityId === securityId)
          ?.currentPrice ?? null,
      ),
      accounts,
      activity: this.buildActivity(
        securityId,
        history.transactions,
        realizedGains,
      ),
      hasTransactions: history.transactions.length > 0,
      // "Closed" is specifically *was held, now isn't*, measured against the
      // exact balance: a security never traded gets the no-data state instead.
      isPositionClosed:
        history.transactions.length > 0 && history.currentQuantityAll === 0,
      dailyChange: await this.securitiesService.getDailyPriceChange(securityId),
    };
  }

  /**
   * Roll the per-account rows up into one position. Every amount is already in
   * the security's currency, so this is plain addition -- no conversion, and so
   * no chance of a total disagreeing with the rows it came from.
   */
  private buildAggregatePosition(
    accounts: readonly SecurityDetailAccountPosition[],
    exactQuantity: number,
    currentPrice: number | null,
  ): SecurityDetailPosition {
    // A row the portfolio could not cost or price (a holding in a closed
    // account, or a dust residual it filtered out) makes every total a partial
    // one, and a partial total reads as a real value. Report nothing instead.
    const isCostComplete = accounts.every(
      (a) => a.costBasis !== null && a.averageCost !== null,
    );
    const isPriceComplete =
      accounts.length > 0 && accounts.every((a) => a.marketValue !== null);

    const costBasis = isCostComplete
      ? sumMoney(accounts.map((a) => a.costBasis as number))
      : null;
    const marketValue = isPriceComplete
      ? sumMoney(accounts.map((a) => a.marketValue as number))
      : null;
    const gainLoss =
      marketValue === null || costBasis === null
        ? null
        : roundMoney(marketValue - costBasis);

    return {
      quantity: exactQuantity,
      averageCost:
        !isCostComplete || exactQuantity === 0
          ? null
          : this.weightedAverageCost(accounts, exactQuantity),
      currentPrice,
      costBasis,
      marketValue,
      gainLoss,
      gainLossPercent:
        gainLoss === null || costBasis === null || costBasis <= 0
          ? null
          : (gainLoss / costBasis) * 100,
    };
  }

  /**
   * Average cost per unit across the accounts, weighted by units held.
   *
   * Mathematically the same thing as total cost over total units, but computed
   * from the per-account averages -- which sit at the full precision
   * `holdings.average_cost` stores -- rather than from the summed cost basis.
   * That sum is money, so it is rounded to 4dp, and dividing a 4dp figure by a
   * large unit count throws away most of the significant digits of a sub-cent
   * price: a holding of 15,000 units costing 1.8518517 in total came back as
   * 0.00012346 per unit instead of 0.00012345678.
   *
   * Weighting matters as much as precision: a plain mean of the per-account
   * averages would misweight unequal positions.
   */
  private weightedAverageCost(
    accounts: readonly SecurityDetailAccountPosition[],
    exactQuantity: number,
  ): number {
    const totalCost = accounts.reduce(
      (sum, account) =>
        sum + account.quantity * (account.averageCost as number),
      0,
    );
    return roundToDecimals(totalCost / exactQuantity, UNIT_PRICE_DECIMALS);
  }

  /**
   * Realized gains for this security, scoped to the accounts it was traded in
   * so a large portfolio does not pay for a full-history walk.
   */
  private async loadRealizedGains(
    userId: string,
    accountIds: readonly string[],
  ): Promise<RealizedGainRow[]> {
    if (accountIds.length === 0) return [];
    return this.investmentTransactionsService.getRealizedGains(userId, {
      accountIds: [...accountIds],
    });
  }

  /**
   * What was put in: the executed cost of every acquisition, commission
   * included (`acquisitionCost`, stored total first). A transfer between two
   * of the user's own accounts moves no money in or out of the security, so a
   * paired leg adds nothing. A TRANSFER_IN with no other leg is shares arriving
   * from outside, which counts at its stated cost. A row that cannot state its
   * cost makes the total unknown, never zero.
   */
  private totalInvested(
    effects: readonly SecurityHistoryTransaction[],
  ): number | null {
    const parts: number[] = [];
    for (const tx of effects) {
      const action = baseInvestmentAction(tx.action) as InvestmentAction;
      if (!ACQUIRING_ACTIONS.has(action)) continue;
      if (action === InvestmentAction.TRANSFER_IN && tx.linkedTransactionId) {
        continue;
      }
      const cost = acquisitionCost({
        quantity: Math.abs(Number(tx.quantity) || 0),
        price: tx.price,
        commission: tx.commission,
        totalAmount: tx.totalAmount,
      });
      if (cost === null) return null;
      parts.push(cost);
    }
    return sumMoney(parts);
  }

  private buildActivity(
    securityId: string,
    transactions: readonly SecurityHistoryTransaction[],
    realizedGains: readonly RealizedGainRow[],
  ): SecurityDetailActivity {
    const mine = realizedGains.filter(
      (entry) => entry.securityId === securityId,
    );
    // A sale whose account carries no currency code cannot be attributed to
    // one, so it counts as its own unknown rather than being folded in.
    const currencies = [
      ...new Set(mine.map((entry) => entry.accountCurrencyCode ?? "")),
    ].sort();
    const hasOneCurrency = currencies.length === 1 && currencies[0] !== "";
    // A sale from shares of unknown cost has no gain: the total is unknown,
    // and the gains that are known are a subtotal of it.
    const knownGains = mine.flatMap((entry) =>
      entry.realizedGain === null ? [] : [entry.realizedGain],
    );
    const gainsComplete = knownGains.length === mine.length;

    // The history lists a VOID row as a record, which the dates and the count
    // below still describe; it moved no money, so it joins no money total.
    const effects = transactions.filter(investmentRowHasEffect);
    const amountsFor = (
      predicate: (tx: SecurityHistoryTransaction) => boolean,
    ): number =>
      sumMoney(
        effects.filter(predicate).map((tx) => Number(tx.totalAmount) || 0),
      );

    return {
      // The history is ordered oldest-first by the service that builds it.
      firstTransactionDate: transactions[0]?.transactionDate ?? null,
      lastTransactionDate:
        transactions[transactions.length - 1]?.transactionDate ?? null,
      // Cost, not cash out: `totalAmount` is zero on reinvestments and transfers
      // in, which still acquire shares and still add to cost basis, so summing
      // it would report nothing invested beside a real cost basis.
      totalInvested: this.totalInvested(effects),
      // Base-normalized: a CD/bond redemption is a sale, and the term'd gain
      // distributions are income; the raw action only refines the kind.
      totalSold: amountsFor(
        (tx) => baseInvestmentAction(tx.action) === InvestmentAction.SELL,
      ),
      // Every distribution, paid in cash or reinvested: a reinvestment's shares
      // are in the cost basis this figure is set against, so leaving its
      // income out would read the distribution as no return at all.
      dividends: sumMoney(effects.map((tx) => investmentIncomeAmount(tx))),
      fees: sumMoney(effects.map((tx) => Number(tx.commission) || 0)),
      // One currency, or nothing: gains realized in a PLN account and in a EUR
      // account are not addable, and their sum would be in no currency at all.
      realizedGain:
        hasOneCurrency && gainsComplete ? sumMoney(knownGains) : null,
      realizedGainComplete: gainsComplete,
      realizedGainKnownSubtotal:
        hasOneCurrency && !gainsComplete ? sumMoney(knownGains) : null,
      realizedGainCurrency: hasOneCurrency ? currencies[0] : null,
      realizedGainCurrencies: currencies.filter((code) => code !== ""),
      realizedSaleCount: mine.length,
      transactionCount: transactions.length,
    };
  }
}
