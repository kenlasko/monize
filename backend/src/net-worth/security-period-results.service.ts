import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Security } from "../securities/entities/security.entity";
import { NetWorthService } from "./net-worth.service";
import {
  InvestedFlowDay,
  InvestedFlowRow,
  foldInvestedFlows,
  loadInvestedCapitalFlowRows,
  shareLegCloseFrom,
  type ShareLegClose,
} from "./invested-capital-flow.util";
import { buildFlowRateIndex } from "./period-flow-fold.util";
import {
  PeriodResultReason,
  PeriodResultWindow,
  PortfolioPeriodResultService,
} from "./portfolio-period-result.service";
import {
  SeriesFetchOptions,
  SeriesRateGap,
  computeWithRateFill,
} from "./series-rate-fill";
import {
  SecurityPeriodIdentity,
  SecurityPeriodRow,
  securityPeriodResults,
  splitSecurityIdsOf,
} from "./security-period-result.util";

/** What `GET /net-worth/investments-period-result/securities` answers. */
export interface SecurityPeriodResults {
  /** The currency every money figure is in. */
  currency: string;
  /** The close the window is measured FROM, as the portfolio route reports it. */
  startDate: string;
  /** The close it is measured TO. */
  endDate: string;
  /** Empty, with `noValueSeries`, when the window has no valued day. */
  reasons: PeriodResultReason[];
  securities: SecurityPeriodRow[];
  /** See `SecurityPeriodSplit.unattributedPnl`. */
  unattributedPnl: number | null;
}

/** The capital and income folded per security, over one rate index. */
interface FlowsBySecurity {
  bySecurity: Map<string, Map<string, InvestedFlowDay>>;
  unattributed: Map<string, InvestedFlowDay>;
  gaps: SeriesRateGap[];
}

/**
 * The invested part's period result, one row per security
 * (`docs/specs/investment-performance-report-period.md`).
 *
 * Every input is the one `PortfolioPeriodResultService.getPeriodResult` reads
 * for the same request: the window from its `measuredFrom`, the reporting
 * currency from its `reportingCurrency`, the positions from the same daily
 * fold, the capital and income from the same loader and fold, each share leg
 * valued by the same `shareLegCloseFrom`. Only the split by security is new,
 * which is what lets the rows add up to the card beside them.
 */
@Injectable()
export class SecurityPeriodResultsService {
  private readonly logger = new Logger(SecurityPeriodResultsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly netWorth: NetWorthService,
    private readonly periodResult: PortfolioPeriodResultService,
    // Optional + forwardRef for the reasons PortfolioPeriodResultService gives.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates?: ExchangeRateService,
  ) {}

  async getSecurityPeriodResults(
    userId: string,
    opts: PeriodResultWindow & {
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
    } & SeriesFetchOptions,
  ): Promise<SecurityPeriodResults> {
    const currency = await this.periodResult.reportingCurrency(
      userId,
      opts.displayCurrency,
    );
    const end = opts.endDate || todayYMD();
    const from = await this.periodResult.measuredFrom(userId, opts, end);
    const empty = (start: string): SecurityPeriodResults => ({
      currency,
      startDate: start,
      endDate: end,
      reasons: ["noValueSeries"],
      securities: [],
      unattributedPnl: null,
    });
    if (from === null) return empty(end);
    if (from > end) return empty(from);

    const scope = await this.periodResult.resolveScope(userId, opts.accountIds);
    if (scope.length === 0) return empty(from);

    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));

    const [daily, flowRows] = await Promise.all([
      this.netWorth.getDailyInvestmentPositions(userId, {
        startDate: from,
        endDate: end,
        accountIds: opts.accountIds,
        displayCurrency: currency,
        fetchMissing: opts.fetchMissing,
      }),
      loadInvestedCapitalFlowRows(query, {
        userId,
        afterDate: from,
        throughDate: end,
        accountIds: scope.map((row) => row.id),
      }),
    ]);
    if (daily.positions.length === 0) return empty(from);

    const securityIds = new Set<string>();
    for (const day of daily.positions) {
      for (const id of day.quantities.keys()) securityIds.add(id);
    }
    for (const row of flowRows) {
      if (row.securityId) securityIds.add(row.securityId);
    }

    // One resolver for a share leg's value and for the closes the price change
    // reads: the same merge rule, over the same series, the value fold uses.
    const closeAt = shareLegCloseFrom(
      await this.netWorth.loadValuationSeries([...securityIds], from, end),
    );

    const flows = await computeWithRateFill(
      this.exchangeRates,
      () => this.foldBySecurity(flowRows, currency, from, end, closeAt),
      (folded) => folded.gaps,
      { fetchMissing: opts.fetchMissing },
      this.logger,
    );

    const split = securityPeriodResults({
      days: daily.positions,
      flowsBySecurity: flows.bySecurity,
      unattributedFlows: flows.unattributed,
      splitSecurityIds: splitSecurityIdsOf(flowRows),
      securities: await this.identities(daily.securities, securityIds),
      closeAt,
      currency,
    });

    return {
      currency,
      startDate: daily.positions[0].date,
      endDate: daily.positions[daily.positions.length - 1].date,
      reasons: [],
      ...split,
    };
  }

  /**
   * `foldInvestedFlows` once per security, over ONE rate index loaded fresh,
   * so a day converts at the same rate whichever security's row it is.
   */
  private async foldBySecurity(
    rows: readonly InvestedFlowRow[],
    currency: string,
    start: string,
    end: string,
    closeAt: ShareLegClose,
  ): Promise<FlowsBySecurity> {
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));
    const rateIndex = await buildFlowRateIndex(
      query,
      rows,
      currency,
      start,
      end,
    );
    const groups = new Map<string | null, InvestedFlowRow[]>();
    for (const row of rows) {
      const group = groups.get(row.securityId) ?? [];
      group.push(row);
      groups.set(row.securityId, group);
    }
    const bySecurity = new Map<string, Map<string, InvestedFlowDay>>();
    let unattributed = new Map<string, InvestedFlowDay>();
    const gaps: SeriesRateGap[] = [];
    for (const [securityId, group] of groups) {
      const folded = foldInvestedFlows(
        group,
        currency,
        rateIndex,
        this.logger,
        closeAt,
      );
      gaps.push(...folded.gaps);
      if (securityId === null) unattributed = folded.byDay;
      else if (folded.byDay.size > 0) bySecurity.set(securityId, folded.byDay);
    }
    return { bySecurity, unattributed, gaps };
  }

  /**
   * Symbol, name and quote currency for every row. The daily fold already
   * loaded every security it replayed; a row only the flow load names is read
   * here.
   */
  private async identities(
    loaded: Map<string, Security>,
    ids: ReadonlySet<string>,
  ): Promise<Map<string, SecurityPeriodIdentity>> {
    const missing = [...ids].filter((id) => !loaded.has(id));
    const extra =
      missing.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findBy({ id: In(missing) }),
          )
        : [];
    const identities = new Map<string, SecurityPeriodIdentity>();
    for (const security of [...loaded.values(), ...extra]) {
      identities.set(security.id, {
        symbol: security.symbol,
        name: security.name,
        currencyCode: security.currencyCode,
      });
    }
    return identities;
  }
}
