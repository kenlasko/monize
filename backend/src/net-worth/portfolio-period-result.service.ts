import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import { loadFirstInvestmentDate } from "./investment-inception.util";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "../securities/investment-scope.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService, isValuationCashAccount } from "./net-worth.service";
import { SeriesFetchOptions, computeWithRateFill } from "./series-rate-fill";
import {
  FlowSubtotalRow,
  FoldedFlow,
  buildFlowRateIndex,
  foldFlowSubtotals,
} from "./period-flow-fold.util";
import {
  EMPTY_INCOMPLETE_RANGES,
  IncompleteDataRanges,
  foldIncompleteData,
  withFlowUnpricedSecurities,
} from "./incomplete-data-ranges.util";
import {
  PeriodResultReason,
  PeriodReturnMethod,
  UnmeasuredFlowCounts,
  decidePeriodResult,
} from "./portfolio-period-result.util";
import {
  FoldedInvestedFlows,
  InvestedFlowRow,
  ShareLegClose,
  foldInvestedFlows,
  loadInvestedCapitalFlowRows,
  shareLegCloseFrom,
  shareLegSecurityIds,
} from "./invested-capital-flow.util";
import {
  InvestedPeriodDecision,
  InvestedReturnMethod,
  MoneyWeightedReturnMethod,
  NO_INVESTED_PERIOD,
  investedPeriodResult,
} from "./invested-period-result.util";
import {
  loadUnmeasuredFlowRows,
  unmeasuredFlowsAfter,
} from "./unmeasured-flows.util";
import {
  PortfolioPeriodPreset,
  presetWindowStart,
  usesPriorCloseBaseline,
} from "./portfolio-period-presets.util";

/** Both folds of one window, over one rate index. */
interface PeriodFolds {
  flow: FoldedFlow;
  invested: FoldedInvestedFlows;
}

/** One account of the scope, with what the cash boundary is decided from. */
export interface ScopeAccount {
  id: string;
  account_type: string;
  account_sub_type: string | null;
}

export {
  PeriodResultReason,
  PeriodReturnMethod,
  InvestedReturnMethod,
  MoneyWeightedReturnMethod,
};

/**
 * How a caller names the window it wants measured.
 *
 * Either a preset the server resolves (`period`) or an explicit pair of dates,
 * never a mix: a caller that sends both would be asking two questions, and the
 * answer would silently be one of them.
 */
export type PeriodResultWindow =
  | {
      period: PortfolioPeriodPreset;
      startDate?: undefined;
      baselineDate?: undefined;
    }
  | { period?: undefined; startDate: string; baselineDate?: string };

/** What `GET /net-worth/investments-period-result` answers. */
export interface PortfolioPeriodResult {
  /** The currency every figure below is in. */
  currency: string;
  /** The close the period is measured FROM (the baseline, where one was given). */
  startDate: string;
  /**
   * The trading session `startDate`'s value came from: the newest day on or
   * before it carrying a close for anything the scope held by then.
   *
   * `startDate` is a CALENDAR day, and the value series prices every calendar
   * day from the latest close at or before it -- so a Monday window measured
   * from Sunday is measured from Friday's close, and a surface that prints
   * `startDate` as the close it reports against names a day the market was
   * shut. This is the day to print. `null` when nothing in the scope was
   * priced by then: unknown, never substituted with the calendar day.
   */
  startPriceDate: string | null;
  /** The close the period is measured TO. */
  endDate: string;
  /** MV(b); null when that day is a subtotal. */
  startValue: number | null;
  /** MV(e); null when that day is a subtotal. */
  endValue: number | null;
  /** `MV(e) - MV(b)`. What the portfolio is worth now, less what it was. */
  valueChange: number | null;
  /** Cash that crossed the scope's boundary after `startDate`, net. */
  netExternalFlows: number | null;
  /** The part of the flow that converted, when the total is withheld. */
  knownFlowSubtotal: number;
  /** `valueChange - netExternalFlows`. What the market did, and nothing else. */
  investmentResult: number | null;
  /** The result over the starting value; see `returnMethod`. */
  returnPercent: number | null;
  returnMethod: PeriodReturnMethod;
  /** True only when every figure above is known, the percentage included. */
  complete: boolean;
  reasons: PeriodResultReason[];
  missingRatePairs: string[];
  unpricedSecurityIds: string[];
  unknownCashAccountIds: string[];
  /**
   * The same three causes DATED: each key's runs of consecutive points over the
   * window, rather than the union sets above, which say what is missing and not
   * when. "AGGG, Jun 16-20" is a repair; a set of ids is a guess
   * (`docs/specs/portfolio-period-result.md` section 10.7). Bounded per cause;
   * `truncated` says a list is the newest runs rather than all of them.
   */
  incompleteRanges: IncompleteDataRanges;

  // The invested part of the same window: securities only, cash excluded
  // entirely (INV-PORTRESULT-002, `docs/specs/portfolio-period-result.md`
  // section 10). These are what "Portfolio performance" reports; the fields
  // above are what the account did, which is a different question.

  /** `IV(b)`: the securities at the starting close, no cash. */
  investedValueStart: number | null;
  /** `IV(e)`: the securities at the ending close, no cash. */
  investedValueEnd: number | null;
  /**
   * `IV(e) - IV(b)`: the last point the value chart draws less its first. Known
   * whenever both boundary days are complete, even where the P&L is withheld.
   */
  investedValueChange: number | null;
  /** Net value paid INTO the securities after `startDate`: buys less disposals. */
  investmentCapitalFlows: number | null;
  /** Dividends, interest and capital-gain distributions over the same days. */
  investmentIncome: number | null;
  /** What the investments earned: `IV(e) - IV(b) - capital + income`. */
  investmentPnl: number | null;
  /** The time-weighted return over the same days; see `investmentReturnMethod`. */
  investmentReturnPercent: number | null;
  investmentReturnMethod: InvestedReturnMethod;
  /**
   * The ANNUALISED money-weighted return (XIRR) over the same flows: what the
   * reader's own money earned, weighted by when it was paid in
   * (`docs/specs/portfolio-period-result.md` section 11). `null` is withheld,
   * with `mwrUndefined` or `windowTooShort` among `investedReasons`.
   */
  investmentMoneyWeightedReturnPercent: number | null;
  /** The same rate over the window rather than a year; a rate, not a realised total. */
  investmentMoneyWeightedTotalPercent: number | null;
  investmentMoneyWeightedMethod: MoneyWeightedReturnMethod;
  /** True only when both invested figures are known. */
  investedComplete: boolean;
  /** Why an invested figure is withheld; the same closed set as `reasons`. */
  investedReasons: PeriodResultReason[];
}

/**
 * What a portfolio did over a period, net of the money its owner put in.
 *
 * The report used to print `last - first` over the value series and a percentage
 * of the first point, so two deposits with a price that never moved read as a
 * hundred per cent gain (#1392). The three figures a reader needs are different
 * questions and are answered separately here: how much the portfolio is worth
 * now against then (`valueChange`), how much of that the reader moved in or out
 * (`netExternalFlows`), and what is left (`investmentResult`) -- the only one a
 * percentage belongs over.
 *
 * Nothing here re-values anything. The boundaries are two points of the very
 * series the chart draws (`NetWorthService.getDailyInvestments`, which resolves
 * the scope through `resolveInvestmentScopeAccountIds` as every other investment
 * surface does), and the flow is classified by the shared predicate in
 * `external-flow.util.ts` and converted through the one date-aware rate door.
 * A second valuation would be a second answer to "what was this worth", which is
 * the disagreement these endpoints exist to prevent.
 *
 * Whether a figure may be reported at all is decided once, in
 * `decidePeriodResult`; `docs/specs/portfolio-period-result.md` is the measure.
 */
@Injectable()
export class PortfolioPeriodResultService {
  private readonly logger = new Logger(PortfolioPeriodResultService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly netWorth: NetWorthService,
    // The read-path FX fill for the flow fold; the value series fills through
    // NetWorthService. Optional + forwardRef for the same reasons it is there:
    // CurrenciesModule reaches back here through SecuritiesModule, and a
    // harness without it reports the pair missing exactly as before.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates?: ExchangeRateService,
  ) {}

  /**
   * The period's result for one scope and window.
   *
   * The window is named ONE of two ways. `period` names a preset and the server
   * draws its window from `portfolio-period-presets.util.ts` -- the same
   * arithmetic, from the same file, that the batch route uses, so a chart's
   * card and the performance card beside it cannot report different figures
   * under the same caption. The chart sent the window it DREW,
   * which opens a day early on 3M/1Y/5Y, a week early on 1D and nowhere at all
   * on All). `startDate`/`baselineDate` name an explicit window instead, for a
   * caller with no preset to name.
   *
   * `baselineDate` is the close the period is measured from where that is NOT
   * the first day of the window: the 1d / 1w / mtd ranges report against the
   * previous trading day's close. The lower bound for flows is exclusive of it
   * -- the baseline's own close already contains every flow that landed that
   * day, and counting those again would subtract them from a starting value
   * that holds them.
   */
  async getPeriodResult(
    userId: string,
    opts: PeriodResultWindow & {
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
    } & SeriesFetchOptions,
  ): Promise<PortfolioPeriodResult> {
    const currency = await this.reportingCurrency(userId, opts.displayCurrency);
    const end = opts.endDate || todayYMD();

    const from = await this.measuredFrom(userId, opts, end);
    // A preset whose window this scope has no history for is a period that
    // cannot be measured, not one that did nothing.
    if (from === null) return this.emptyResult(currency, end, end);

    const empty = this.emptyResult(currency, from, end);

    if (from > end) return empty;

    const scope = await this.resolveScope(userId, opts.accountIds);
    if (scope.length === 0) return empty;
    // ONE boundary. The flow is drawn around the accounts whose cash the
    // valuation actually walks, on both sides of a transfer: a deposit posted
    // straight to a brokerage row is a flow the series never sees, and
    // subtracting it from a value change that does not hold it is a loss
    // nobody made (`docs/specs/portfolio-period-result.md` section 6).
    const cashScope = scope
      .filter((row) => isValuationCashAccount(row))
      .map((row) => row.id);

    // The same series the chart reads, for the same scope, in the same currency.
    // Its first and last points ARE the period's boundaries: a day is valued
    // from the latest accepted close on or before it, and the price loaders
    // carry one pre-window observation, so the first point does not depend on
    // how wide a window the caller asked for.
    const [series, flowRows, investedRows, unmeasuredFlows, pricedDays] =
      await Promise.all([
        this.netWorth.getDailyInvestments(
          userId,
          from,
          end,
          opts.accountIds,
          currency,
          // One opt-out for the whole answer: the value series and the flow fold
          // read the same rates and must not disagree about whether to fetch.
          { fetchMissing: opts.fetchMissing },
        ),
        loadExternalFlowSubtotals(
          (sql, params) =>
            withScopedDb(this.dataSource, (m) => m.query(sql, params)),
          {
            userId,
            // Exclusive: a flow dated on the baseline is already inside MV(b).
            afterDate: from,
            throughDate: end,
            accountIds: cashScope,
            // A trade on the scope whose cash leg transfers into a sleeve settled
            // inside, not across the boundary (the QIF/CSV import's shape).
            investmentScope: scope.map((row) => row.id),
            perDay: true,
          },
        ),
        // The invested part's own capital and income, over the same window and
        // the whole scope: investment rows live on the brokerage sleeves, which
        // the cash boundary above deliberately excludes.
        loadInvestedCapitalFlowRows(
          (sql, params) =>
            withScopedDb(this.dataSource, (m) => m.query(sql, params)),
          {
            userId,
            afterDate: from,
            throughDate: end,
            accountIds: scope.map((row) => row.id),
          },
        ),
        this.countUnmeasuredFlows(userId, from, end, {
          scope: scope.map((row) => row.id),
          cashScope,
        }),
        // Which SESSION the opening value came from. `from` is the series' first
        // point (`enumerateDaysYMD` opens on it), so this is asked beside the
        // series rather than after it.
        this.netWorth.getLastPricedDays(
          userId,
          [from],
          scope.map((row) => row.id),
        ),
      ]);

    if (series.length === 0) return empty;

    // The closes a share-moving leg is valued at: the SAME series the value
    // chart was built from, so `IV` and `K` move by one number for one day's
    // shares. Asked only where such a leg exists, which is the uncommon case.
    const shareLegClose = shareLegCloseFrom(
      await this.netWorth.loadValuationSeries(
        shareLegSecurityIds(investedRows),
        from,
        end,
      ),
    );

    const { flow, invested } = await this.foldFlows(
      flowRows,
      investedRows,
      currency,
      from,
      end,
      shareLegClose,
      { fetchMissing: opts.fetchMissing },
    );

    const decision = decidePeriodResult({
      start: series[0],
      end: series[series.length - 1],
      flow,
      unmeasuredFlows,
    });

    // The same series and the same window, measured over the securities
    // alone. The uncountable-movement counts are the account result's: this
    // measure does not read where a row's cash settled.
    const investedDecision: InvestedPeriodDecision = investedPeriodResult({
      points: series,
      startIndex: 0,
      endIndex: series.length - 1,
      flowsByDay: invested.byDay,
    });

    return {
      currency,
      startDate: series[0].date,
      startPriceDate: pricedDays.get(series[0].date) ?? null,
      endDate: series[series.length - 1].date,
      ...decision,
      // The whole window's points, not only its two boundaries: a gap in the
      // middle is what withholds the time-weighted chain, and the reader is
      // told which security on which days rather than that "a price" is
      // missing (#1392).
      incompleteRanges: foldIncompleteData(
        withFlowUnpricedSecurities(series, invested.byDay),
      ),
      ...investedDecision,
    };
  }

  /**
   * The INVESTED part's result over the scope's whole life, for a surface whose
   * caption is "since inception" rather than a window.
   *
   * The portfolio summary's `timeWeightedReturn` used to be a second, older
   * implementation of this measure: it valued each sub-period from
   * `security_prices` alone and silently OMITTED a position with no stored
   * close on a boundary, so a position entered the chain as a gain on the first
   * boundary that priced it, it valued its final sub-period from a different
   * price source, and it counted no income and knew nothing of the
   * invested/cash split. Two implementations of one caption are two answers to
   * one question (#1392), so the window is resolved here and the figures come
   * from `getPeriodResult` -- the same series, the same capital and income
   * load, the same rate index and the same `investedPeriodResult` decision the
   * period card reads. Nothing is recomputed; only the dates are chosen. The
   * batch route's own `all` window draws these same two dates, so the card's
   * all-time row and this figure are one answer.
   *
   * `b` is the day BEFORE the scope's earliest non-VOID investment transaction,
   * because `IV(b)` is a close and already holds everything dated `b`: measuring
   * from the first transaction's own close would drop the day that bought the
   * portfolio out of the chain. `e` is the routes' own `todayYMD()`.
   */
  async getInvestedResultSinceInception(
    userId: string,
    opts: {
      accountIds?: string[];
      displayCurrency?: string;
    } & SeriesFetchOptions = {},
  ): Promise<PortfolioPeriodResult> {
    return this.getPeriodResult(userId, {
      period: "all",
      endDate: todayYMD(),
      accountIds: opts.accountIds,
      displayCurrency: await this.reportingCurrency(
        userId,
        opts.displayCurrency,
      ),
      fetchMissing: opts.fetchMissing,
    });
  }

  /**
   * The close a window is measured FROM: `b`, the series' first point.
   *
   * Public because the per-security split of the same measure
   * (`security-period-results.service.ts`) must open on the very day this
   * route opens on for the same request, and one resolver is how the two
   * cannot drift (`docs/specs/investment-performance-report-period.md`
   * section 3). `null` is a preset this scope has no history for.
   */
  async measuredFrom(
    userId: string,
    opts: PeriodResultWindow & { accountIds?: string[] },
    end: string,
  ): Promise<string | null> {
    const window = opts.period
      ? await this.presetWindow(userId, opts.period, end, opts.accountIds)
      : { startDate: opts.startDate, baselineDate: opts.baselineDate };
    if (window === null) return null;
    // The baseline is the earlier of the two when both are given, so a client
    // that sends a prior close cannot narrow the window it asked to chart.
    return window.baselineDate && window.baselineDate < window.startDate
      ? window.baselineDate
      : window.startDate;
  }

  /**
   * The window a preset names, for this scope and this end day.
   *
   * Every arithmetic answer comes from `portfolio-period-presets.util.ts`, the
   * one file that owns where each window opens; `all` is the exception with no
   * arithmetic, and opens on the day before the scope's first holding, because
   * that purchase's own close already holds it. `null` is a scope with no
   * history at all: there is no window to measure, which is the empty decision
   * rather than a zero.
   */
  private async presetWindow(
    userId: string,
    preset: PortfolioPeriodPreset,
    end: string,
    accountIds?: string[],
  ): Promise<{ startDate: string; baselineDate?: string } | null> {
    if (preset !== "all") {
      const start = presetWindowStart(preset, end);
      if (start === null) return null;
      return {
        startDate: start,
        baselineDate: usesPriorCloseBaseline(preset)
          ? addDaysYMD(start, -1)
          : undefined,
      };
    }
    const scope = await this.resolveScope(userId, accountIds);
    if (scope.length === 0) return null;
    const first = await this.firstInvestmentDate(
      userId,
      scope.map((row) => row.id),
    );
    if (first === null) return null;
    return { startDate: first, baselineDate: addDaysYMD(first, -1) };
  }

  /**
   * The scope's earliest investment transaction date, or `null` when it has
   * none. Rows as EFFECTS: a VOID row records something that did not happen, so
   * it cannot be the day a portfolio started (`investmentEffectStatusSql`).
   *
   * Public because the batch route asks the same question of the same scope:
   * where `all` opens, and which of the long windows the scope has history for
   * (`portfolio-period-results-batch.service.ts`). One spelling of "when did
   * this portfolio start", or the card's all-time row and the summary's
   * since-inception figure would open on different days.
   */
  async firstInvestmentDate(
    userId: string,
    accountIds: string[],
  ): Promise<string | null> {
    return loadFirstInvestmentDate(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      userId,
      accountIds,
    );
  }

  /** The answer for a scope or window with no valued day in it at all. */
  private emptyResult(
    currency: string,
    from: string,
    end: string,
  ): PortfolioPeriodResult {
    return {
      currency,
      startDate: from,
      // No valued day is no session to name: a date here would claim the
      // window was measured from a close it never read.
      startPriceDate: null,
      endDate: end,
      startValue: null,
      endValue: null,
      valueChange: null,
      netExternalFlows: null,
      knownFlowSubtotal: 0,
      investmentResult: null,
      returnPercent: null,
      returnMethod: "simple",
      complete: false,
      reasons: ["noValueSeries"],
      missingRatePairs: [],
      unpricedSecurityIds: [],
      unknownCashAccountIds: [],
      incompleteRanges: EMPTY_INCOMPLETE_RANGES,
      ...NO_INVESTED_PERIOD,
    };
  }

  /**
   * The period's net external flow in the reporting currency, through the one
   * fold every period route shares (`period-flow-fold.util.ts`): each day's
   * subtotal converted at that day's own rate, and a subtotal that would not
   * convert making the whole flow incomplete rather than smaller.
   *
   * A day whose flow could not be converted is also a gap the provider may be
   * able to close, so the fold runs through `computeWithRateFill`: it names the
   * months and pairs it was short of, the provider is asked once per unit, and
   * on a successful fill the index is re-read from the database and the fold
   * re-run. Nothing is invented -- what the provider does not carry stays in
   * `missingPairs` and still withholds the result.
   */
  private foldFlows(
    rows: FlowSubtotalRow[],
    investedRows: InvestedFlowRow[],
    currency: string,
    start: string,
    end: string,
    shareLegClose: ShareLegClose,
    options?: SeriesFetchOptions,
  ): Promise<PeriodFolds> {
    return computeWithRateFill(
      this.exchangeRates,
      () =>
        this.foldFlowsAt(
          rows,
          investedRows,
          currency,
          start,
          end,
          shareLegClose,
        ),
      (folded) => [...folded.flow.gaps, ...folded.invested.gaps],
      options,
      this.logger,
    );
  }

  /**
   * One pass of `foldFlows` over ONE rate index, freshly loaded.
   *
   * Both folds read the same index: the account's external flows and the
   * invested part's capital and income are two questions over one window, and
   * two indexes would be two sets of rates a day could resolve from.
   */
  private async foldFlowsAt(
    rows: FlowSubtotalRow[],
    investedRows: InvestedFlowRow[],
    currency: string,
    start: string,
    end: string,
    shareLegClose: ShareLegClose,
  ): Promise<PeriodFolds> {
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));
    const rateIndex = await buildFlowRateIndex(
      query,
      [...rows, ...investedRows],
      currency,
      start,
      end,
    );
    return {
      flow: foldFlowSubtotals(rows, currency, rateIndex, this.logger),
      invested: foldInvestedFlows(
        investedRows,
        currency,
        rateIndex,
        this.logger,
        shareLegClose,
      ),
    };
  }

  /** Public because the batch route reports in the very same currency. */
  async reportingCurrency(
    userId: string,
    displayCurrency?: string,
  ): Promise<string> {
    if (displayCurrency) return displayCurrency;
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preferredCurrency(pref);
  }

  /**
   * How many movements in the window the flow classifier cannot count.
   *
   * The two coarse cases and their predicates are `unmeasured-flows.util.ts`,
   * shared with the batch route so the two cannot disagree about whether a
   * period is measurable. Counted, not measured: what each is worth is a
   * line-granular rewrite of the classifier, and a count is enough to withhold.
   */
  private async countUnmeasuredFlows(
    userId: string,
    afterDate: string,
    throughDate: string,
    sets: { scope: string[]; cashScope: string[] },
  ): Promise<UnmeasuredFlowCounts> {
    const rows = await loadUnmeasuredFlowRows(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      {
        userId,
        afterDate,
        throughDate,
        scope: sets.scope,
        cashScope: sets.cashScope,
      },
    );
    return unmeasuredFlowsAfter(rows);
  }

  /**
   * The accounts in scope, widened to linked pairs exactly as valuation does,
   * carrying the type columns the cash boundary is drawn from. Public for the
   * same reason as `reportingCurrency`: one scope, resolved once, for every
   * route that reports over it.
   */
  async resolveScope(
    userId: string,
    accountIds?: string[],
  ): Promise<ScopeAccount[]> {
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));

    if (accountIds && accountIds.length > 0) {
      const ids = await resolveInvestmentScopeAccountIds(
        query,
        userId,
        accountIds,
      );
      if (ids.length === 0) return [];
      return query(
        `SELECT a.id, a.account_type, a.account_sub_type FROM accounts a
          WHERE a.user_id = $1 AND a.id = ANY($2::UUID[])`,
        [userId, ids],
      ) as Promise<ScopeAccount[]>;
    }
    return query(
      `SELECT a.id, a.account_type, a.account_sub_type FROM accounts a
        WHERE a.user_id = $1 AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`,
      [userId],
    ) as Promise<ScopeAccount[]>;
  }
}
