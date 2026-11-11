import { Injectable } from "@nestjs/common";

import { todayYMD } from "../common/date-utils";
import {
  EMPTY_INCOMPLETE_RANGES,
  IncompleteDataRanges,
  foldIncompleteData,
  withFlowUnpricedSecurities,
} from "./incomplete-data-ranges.util";
import {
  InvestedTwrSeries,
  investedTwrSeries,
} from "./invested-twr-series.util";
import { NetWorthService } from "./net-worth.service";
import {
  PeriodResultWindow,
  PortfolioPeriodResultService,
} from "./portfolio-period-result.service";
import { SeriesFetchOptions } from "./series-rate-fill";

/** The window, scope and currency a series is asked for. */
export type TwrSeriesQuery = PeriodResultWindow & {
  endDate?: string;
  accountIds?: string[];
  displayCurrency?: string;
} & SeriesFetchOptions;

/** What `GET /net-worth/investments-twr-series` answers for one scope. */
export interface PortfolioTwrSeries extends InvestedTwrSeries {
  /** The currency the series' valuation was made in. */
  currency: string;
  /** The close the series opens on, as the period result reports it. */
  startDate: string;
  /** The close it ends on. */
  endDate: string;
  /** Which security on which days withheld it, in the period result's shape. */
  incompleteRanges: IncompleteDataRanges;
}

/** One account's series, in `groupBy=account` mode. */
export interface AccountTwrSeries extends InvestedTwrSeries {
  accountId: string;
  incompleteRanges: IncompleteDataRanges;
}

/** What `GET /net-worth/investments-twr-series?groupBy=account` answers. */
export interface PortfolioTwrSeriesByAccount {
  currency: string;
  startDate: string;
  endDate: string;
  accounts: AccountTwrSeries[];
}

/**
 * The invested part's time-weighted return as a series, for the whole scope or
 * one series per account (`docs/specs/portfolio-twr-series.md`).
 *
 * Nothing is valued here. The days are the series the value chart draws
 * (`NetWorthService.getDailyInvestments`), the capital and income are the rows
 * `PortfolioPeriodResultService.getPeriodResult` folds for its invested part,
 * through the same fold and the same rate index, and the arithmetic is
 * `investedTwrSeries` over the same `investedPeriodResult` decision. The series
 * therefore ends on the period result's `investmentReturnPercent`
 * (INV-PORTTWR-001), and is withheld where it is.
 *
 * Each account is its own scope, not a slice of the combined series: a chained
 * return is not a weighted sum of the chains of its parts.
 */
@Injectable()
export class PortfolioTwrSeriesService {
  constructor(
    private readonly netWorth: NetWorthService,
    private readonly periodResult: PortfolioPeriodResultService,
  ) {}

  /** One series for the scope `accountIds` names (every investment account when omitted). */
  async getSeries(
    userId: string,
    opts: TwrSeriesQuery,
  ): Promise<PortfolioTwrSeries> {
    const currency = await this.periodResult.reportingCurrency(
      userId,
      opts.displayCurrency,
    );
    const end = opts.endDate || todayYMD();
    const from = await this.periodResult.measuredFrom(userId, opts, end);
    // A preset whose window this scope has no history for cannot be measured.
    if (from === null) return this.empty(currency, end, end);
    if (from > end) return this.empty(currency, from, end);
    return this.measure(userId, {
      currency,
      from,
      end,
      accountIds: opts.accountIds,
      fetchMissing: opts.fetchMissing,
    });
  }

  /**
   * One series per account, every one over the SAME window: opened on the day
   * the combined scope's window opens, so an account that began later is flat
   * at zero until its first day with capital at risk, rather than each line
   * rebasing on its own first day and the lines no longer sharing an origin.
   *
   * `accountIds` are the distinct accounts to measure, and the bound on how
   * many is the caller's. `requestedAccountIds`, when given, are every account
   * the caller named, in order: one the caller may not read is answered as an
   * empty series under its own id, never measured and never silently dropped.
   */
  async getSeriesByAccount(
    userId: string,
    opts: TwrSeriesQuery & {
      accountIds: string[];
      requestedAccountIds?: string[];
    },
  ): Promise<PortfolioTwrSeriesByAccount> {
    const measurable = new Set(opts.accountIds);
    const answered = opts.requestedAccountIds ?? opts.accountIds;
    const currency = await this.periodResult.reportingCurrency(
      userId,
      opts.displayCurrency,
    );
    const end = opts.endDate || todayYMD();
    // Nothing readable: no window to resolve, and an empty scope must never
    // reach a resolver that reads "no ids" as "every account".
    const from =
      measurable.size === 0
        ? null
        : await this.periodResult.measuredFrom(userId, opts, end);
    if (from === null || from > end) {
      const start = from ?? end;
      return {
        currency,
        startDate: start,
        endDate: end,
        accounts: answered.map((accountId) => ({
          accountId,
          ...this.empty(currency, start, end),
        })),
      };
    }

    const accounts: AccountTwrSeries[] = [];
    // In turn: every read below shares the request's one connection.
    for (const accountId of answered) {
      const one = measurable.has(accountId)
        ? await this.measure(userId, {
            currency,
            from,
            end,
            accountIds: [accountId],
            fetchMissing: opts.fetchMissing,
          })
        : this.empty(currency, from, end);
      accounts.push({
        accountId,
        points: one.points,
        complete: one.complete,
        reasons: one.reasons,
        incompleteRanges: one.incompleteRanges,
      });
    }
    return { currency, startDate: from, endDate: end, accounts };
  }

  /** One scope over one explicit window `[from, end]`. */
  private async measure(
    userId: string,
    args: {
      currency: string;
      from: string;
      end: string;
      accountIds?: string[];
      fetchMissing?: boolean;
    },
  ): Promise<PortfolioTwrSeries> {
    const { currency, from, end, accountIds } = args;
    const scope = await this.periodResult.resolveScope(userId, accountIds);
    if (scope.length === 0) return this.empty(currency, from, end);

    // The value series and the invested rows are independent reads, asked
    // together as `getPeriodResult` asks them.
    const [series, investedRows] = await Promise.all([
      this.netWorth.getDailyInvestments(
        userId,
        from,
        end,
        accountIds,
        currency,
        { fetchMissing: args.fetchMissing },
      ),
      this.periodResult.loadInvestedRows(userId, scope, from, end),
    ]);
    if (series.length === 0) return this.empty(currency, from, end);

    const shareLegClose = await this.periodResult.loadShareLegClose(
      investedRows,
      from,
      end,
    );
    // The invested part only: the account-level cash flows are not read by this
    // measure, so none are loaded.
    const { invested } = await this.periodResult.foldFlows(
      [],
      investedRows,
      currency,
      from,
      end,
      shareLegClose,
      { fetchMissing: args.fetchMissing },
    );

    const twr = investedTwrSeries({
      points: series,
      startIndex: 0,
      endIndex: series.length - 1,
      flowsByDay: invested.byDay,
    });
    return {
      currency,
      startDate: series[0].date,
      endDate: series[series.length - 1].date,
      ...twr,
      incompleteRanges: foldIncompleteData(
        withFlowUnpricedSecurities(series, invested.byDay),
      ),
    };
  }

  /** A scope or window with no valued day in it at all. */
  private empty(
    currency: string,
    from: string,
    end: string,
  ): PortfolioTwrSeries {
    return {
      currency,
      startDate: from,
      endDate: end,
      points: [],
      complete: false,
      reasons: ["noValueSeries"],
      incompleteRanges: EMPTY_INCOMPLETE_RANGES,
    };
  }
}
