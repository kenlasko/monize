import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import { roundMoney, roundToDecimals } from "../common/round.util";
import {
  RateIndex,
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { PricePoint } from "../common/time-series/price-boundary.util";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SECURITY_CLOSE_DECIMALS } from "../net-worth/position-price.util";
import { valuationClosePointOn } from "./bond-valuation-close.util";
import { foldExternalFlow } from "../notification-center/portfolio-flow.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Security } from "./entities/security.entity";
import { programTemplate } from "./bond-link.util";
import { loadExternalFlowSubtotals } from "./external-flow.util";
import {
  applyActionToQuantity,
  INVESTMENT_REPLAY_ORDER_SQL,
} from "./investment-replay.util";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "./investment-scope.util";
import {
  DailyMovementReason,
  DailyMovementValue,
  decideDailyMovement,
  valueReasons,
} from "./daily-movement.util";
import { enumerateDaysYMD } from "../net-worth/series-dates.util";

export { DailyMovementReason };

export interface DailyMovementPoint {
  date: string;
  /** At least one security held at that close has a price dated that day. */
  isTradingDay: boolean;
  /** The day's market movement in `currencyCode`; see `complete`. */
  movement: number | null;
  /** The movement as a percentage of the previous day's value. */
  movementPercent: number | null;
  /** True only when the percentage is known; the cell renders from this. */
  complete: boolean;
  reasons: DailyMovementReason[];
}

export interface DailyMovementsResponse {
  currencyCode: string;
  /** The server's financial today; nothing after it is evaluated. */
  today: string;
  days: DailyMovementPoint[];
}

/** One security's contribution to a day's movement. */
export interface SecurityDayMove {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  /** Held at the close of the day, replayed through `applyActionToQuantity`. */
  quantity: number;
  close: number;
  previousClose: number;
  /** The date the previous accepted close was struck on, which may not be d-1. */
  previousCloseDate: string;
  /** `close - previousClose`, in the security's own currency, at price precision. */
  priceChange: number;
  /** `null` when `previousClose` is 0. */
  changePercent: number | null;
  /** `quantity * priceChange` in the reporting currency; `null` with no rate. */
  change: number | null;
}

export interface DailyMovementDetailResponse {
  date: string;
  currencyCode: string;
  movement: number | null;
  movementPercent: number | null;
  complete: boolean;
  reasons: DailyMovementReason[];
  /** Rows that gained, by the money they moved, largest first. */
  gains: SecurityDayMove[];
  /** Rows that lost, by the money they moved, largest first. */
  losses: SecurityDayMove[];
  /** Held positions whose close was struck that day and did not move. */
  unchangedCount: number;
  /**
   * `movement` minus every listed row: the part of the day's move that no
   * per-security close explains -- a dividend, a position first priced that day,
   * cash interest. `null` when any component is unknown, because a remainder
   * computed from a subtotal is a fabricated reconciliation.
   */
  remainder: number | null;
}

/** One investment transaction, as the replay consumes it. */
interface ReplayRow {
  account_id: string;
  security_id: string | null;
  action: string;
  quantity: string;
  transaction_date: string;
}

/**
 * The day's market movement for a portfolio, net of the reader's own
 * contributions -- the measure the daily notification already decided on
 * (`docs/specs/portfolio-movement-notifications.md`), asked per calendar day.
 *
 * `MV(d) - MV(d-1) - externalFlow(d)`. Price-only would misreport a dividend as
 * a loss and a deposit as a gain, which is why this reuses that measure rather
 * than inventing a second one; `external-flow.util.ts` is the shared classifier
 * and `foldExternalFlow` the shared conversion.
 *
 * Nothing here re-derives a value or a share count. Values come from
 * `NetWorthService.getDailyInvestments` with its completeness flags, prices
 * through `valuationClosePointOn` (the one close rule for a blend reader), and
 * quantities from one replay through `applyActionToQuantity` (INV-HOLDING-002)
 * that serves both endpoints. Whether a figure may be reported at all is decided
 * once, in `decideDailyMovement`.
 */
@Injectable()
export class DailyMovementService {
  private readonly logger = new Logger(DailyMovementService.name);

  constructor(
    private readonly dataSource: DataSource,
    // forwardRef: SecuritiesModule and NetWorthModule already close a cycle.
    @Inject(forwardRef(() => NetWorthService))
    private readonly netWorth: NetWorthService,
  ) {}

  /** One point per calendar day in the range, clamped to today. */
  async getDailyMovements(
    userId: string,
    startDate: string,
    endDate: string,
    accountIds?: string[],
    displayCurrency?: string,
  ): Promise<DailyMovementsResponse> {
    const today = todayYMD();
    const currencyCode = await this.reportingCurrency(userId, displayCurrency);
    const dates = enumerateDaysYMD(startDate, endDate);
    // Days after today are not evaluated: there is no future close, and a
    // projected market movement is not something this app claims to know.
    const evaluated = dates.filter((date) => date <= today);

    if (evaluated.length === 0) {
      return { currencyCode, today, days: dates.map(notTradingDay) };
    }

    const model = await this.loadModel(
      userId,
      evaluated[0],
      evaluated[evaluated.length - 1],
      currencyCode,
      accountIds,
    );

    const byDate = new Map<string, DailyMovementPoint>();
    for (const date of evaluated) {
      const decision = decideDailyMovement({
        isTradingDay: model.isTradingDay(date),
        today: model.valueOn(date),
        previous: model.valueOn(addDaysYMD(date, -1)),
        flow: model.flowOn(date, currencyCode),
      });
      byDate.set(date, {
        date,
        isTradingDay: model.isTradingDay(date),
        ...decision,
      });
    }

    return {
      currencyCode,
      today,
      days: dates.map((date) => byDate.get(date) ?? notTradingDay(date)),
    };
  }

  /** The securities behind one day's movement, and what the rows do not explain. */
  async getDailyMovementDetail(
    userId: string,
    date: string,
    accountIds?: string[],
    displayCurrency?: string,
  ): Promise<DailyMovementDetailResponse> {
    const today = todayYMD();
    const currencyCode = await this.reportingCurrency(userId, displayCurrency);

    if (date > today) {
      // No future close, so nothing to compare: blank, not unknown.
      const { isTradingDay: _isTradingDay, ...blank } = notTradingDay(date);
      return {
        ...blank,
        currencyCode,
        gains: [],
        losses: [],
        unchangedCount: 0,
        remainder: null,
      };
    }

    const model = await this.loadModel(
      userId,
      date,
      date,
      currencyCode,
      accountIds,
    );
    const decision = decideDailyMovement({
      isTradingDay: model.isTradingDay(date),
      today: model.valueOn(date),
      previous: model.valueOn(addDaysYMD(date, -1)),
      flow: model.flowOn(date, currencyCode),
    });

    const rows: SecurityDayMove[] = [];
    let unchangedCount = 0;
    for (const [securityId, quantity] of model.holdingsOn(date)) {
      if (Math.abs(quantity) < QUANTITY_EPSILON) continue;

      const point = model.closePointOn(securityId, date);
      // No close struck that day: the position's carried close moved nothing, so
      // it contributes no row (table D).
      if (!point || point.date !== date) continue;

      const previous = model.closePointOn(securityId, addDaysYMD(date, -1));
      // Nothing to compare against: the position's whole value sits in the
      // remainder rather than being reported as a change from zero.
      if (!previous) continue;

      const priceChange = roundToDecimals(
        point.close - previous.close,
        SECURITY_CLOSE_DECIMALS,
      );
      if (priceChange === 0) {
        unchangedCount++;
        continue;
      }

      const security = model.security(securityId);
      const securityCurrency = security?.currencyCode || currencyCode;
      const converted = convertAtDate(
        quantity * priceChange,
        securityCurrency,
        currencyCode,
        date,
        model.rateIndex,
        this.logger,
      );

      rows.push({
        securityId,
        symbol: security?.symbol ?? "",
        name: security?.name ?? "",
        currencyCode: securityCurrency,
        quantity,
        close: point.close,
        previousClose: previous.close,
        previousCloseDate: previous.date,
        priceChange,
        changePercent:
          previous.close === 0
            ? null
            : roundToDecimals(
                (priceChange / previous.close) * 100,
                PORTFOLIO_MOVE_PERCENT_DECIMALS,
              ),
        change: converted === null ? null : roundMoney(converted),
      });
    }

    // Bucketed by the money the row moved, which is what the reader is looking
    // at. A row whose rate is absent has no money to sort by, so it falls back
    // to the direction its price took -- it is still listed, with `change: null`,
    // because dropping it would hide the reason the totals do not reconcile.
    const direction = (row: SecurityDayMove) => row.change ?? row.priceChange;
    const gains = rows
      .filter((row) => direction(row) > 0)
      .sort(byAbsoluteChangeDesc);
    const losses = rows
      .filter((row) => direction(row) < 0)
      .sort(byAbsoluteChangeDesc);

    const anyChangeUnknown = rows.some((row) => row.change === null);
    const explained = rows.reduce(
      (sum, row) => sum + Math.round((row.change ?? 0) * 10000),
      0,
    );

    return {
      date,
      currencyCode,
      ...decision,
      gains,
      losses,
      unchangedCount,
      remainder:
        decision.movement === null || anyChangeUnknown
          ? null
          : roundMoney(decision.movement - explained / 10000),
    };
  }

  private async reportingCurrency(
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
   * Everything both endpoints read, loaded once for `[startDate - 1, endDate]`.
   *
   * The window opens a day early because every point needs its predecessor: a
   * change is a difference of two observations, and the first day of a month
   * compares against the last day of the one before.
   */
  private async loadModel(
    userId: string,
    startDate: string,
    endDate: string,
    currencyCode: string,
    accountIds?: string[],
  ): Promise<MovementModel> {
    const previousDay = addDaysYMD(startDate, -1);
    const scope = await this.resolveScope(userId, accountIds);

    if (scope.length === 0) {
      return new MovementModel({
        values: new Map(),
        flows: new Map(),
        holdings: new Map(),
        priceSeries: { stored: new Map(), txFallback: new Map() },
        securities: new Map(),
        rateIndex: new Map(),
      });
    }

    const replayRows = await this.loadReplayRows(scope, endDate);
    const securityIds = [
      ...new Set(
        replayRows
          .filter((row) => row.security_id)
          .map((row) => row.security_id as string),
      ),
    ];

    const [values, securities, priceSeries, flowRows] = await Promise.all([
      this.netWorth.getDailyInvestments(
        userId,
        previousDay,
        endDate,
        // The scope is already resolved to its linked pairs; passing it back
        // through the same widening is a no-op.
        accountIds,
        currencyCode,
      ),
      securityIds.length > 0
        ? withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : Promise.resolve([]),
      this.netWorth.loadValuationSeries(securityIds, previousDay, endDate),
      loadExternalFlowSubtotals(
        (sql, params) =>
          withScopedDb(this.dataSource, (m) => m.query(sql, params)),
        {
          userId,
          // Exclusive lower bound, so the first evaluated day's own flows count.
          afterDate: previousDay,
          throughDate: endDate,
          accountIds: scope,
          perDay: true,
        },
      ),
    ]);

    const securityMap = new Map<string, MovementSecurity>();
    const cashPriced = new Map<string, boolean>();
    for (const s of securities) {
      const programId = s.bondProgramId ?? null;
      if (programId !== null && !cashPriced.has(programId)) {
        cashPriced.set(programId, await this.isCashPricedProgram(programId));
      }
      securityMap.set(s.id, {
        symbol: s.symbol,
        name: s.name,
        currencyCode: s.currencyCode,
        bondProgramId: programId,
        marketPriceRequired:
          programId !== null && cashPriced.get(programId) === true,
      });
    }
    const currencies = new Set<string>();
    for (const security of securities) {
      if (security.currencyCode && security.currencyCode !== currencyCode) {
        currencies.add(security.currencyCode);
      }
    }
    for (const row of flowRows) {
      if (row.currency !== currencyCode) currencies.add(row.currency);
    }
    const rateIndex = await buildRateIndex(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      currencies,
      currencyCode,
      previousDay,
      endDate,
    );

    const flows = new Map<
      string,
      Array<{ currency: string; amount: number }>
    >();
    for (const row of flowRows) {
      if (!row.date) continue;
      const day = flows.get(row.date) ?? [];
      day.push({ currency: row.currency, amount: row.amount });
      flows.set(row.date, day);
    }

    return new MovementModel({
      values: new Map(
        values.map((point) => [
          point.date,
          {
            value: point.value,
            complete:
              point.fxComplete !== false &&
              point.pricesComplete !== false &&
              point.cashComplete !== false,
            reasons: valueReasons(point),
          } satisfies DailyMovementValue,
        ]),
      ),
      flows,
      holdings: replayHoldings(replayRows, previousDay, endDate),
      priceSeries,
      securities: securityMap,
      rateIndex,
    });
  }

  /**
   * True for a program whose securities trade
   * (`BondProgramDefinition.cashPriced`): the engine writes no price for a
   * security linked to it, so its closes are the person's own prices
   * (INV-BOND-005).
   */
  private async isCashPricedProgram(programId: string): Promise<boolean> {
    const template = await withScopedDb(this.dataSource, (m) =>
      programTemplate(m, programId),
    );
    return template?.cashPriced === true;
  }

  /** The accounts in scope, widened to linked pairs exactly as valuation does. */
  private async resolveScope(
    userId: string,
    accountIds?: string[],
  ): Promise<string[]> {
    if (accountIds && accountIds.length > 0) {
      return resolveInvestmentScopeAccountIds(
        (sql, params) =>
          withScopedDb(this.dataSource, (m) => m.query(sql, params)),
        userId,
        accountIds,
      );
    }
    const rows: Array<{ id: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT a.id FROM accounts a
            WHERE a.user_id = $1 AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`,
          [userId],
        ),
    );
    return rows.map((row) => row.id);
  }

  private loadReplayRows(
    accountIds: string[],
    endDate: string,
  ): Promise<ReplayRow[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT account_id, security_id, action, quantity,
                transaction_date::TEXT AS transaction_date
           FROM investment_transactions
          WHERE account_id = ANY($1::UUID[])
            AND transaction_date <= $2
            AND status != 'VOID'
          ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
        [accountIds, endDate],
      ),
    );
  }
}

/** What the model keeps of a security: its labels and how it is priced. */
interface MovementSecurity {
  symbol?: string;
  name?: string;
  currencyCode?: string;
  bondProgramId?: string | null;
  /** True for a bond-linked security whose price is the person's own (no engine rows). */
  marketPriceRequired?: boolean;
}

/** The two price sources `valuationClosePointOn` reads, as loaded for a window. */
interface PriceSeries {
  stored: Map<string, PricePoint[]>;
  txFallback: Map<string, PricePoint[]>;
}

/** Below this a quantity is a rounding artefact, not a position. */
const QUANTITY_EPSILON = 0.00000001;

/** Everything one request reads, indexed by the questions the decision asks. */
class MovementModel {
  readonly rateIndex: RateIndex;
  private readonly values: Map<string, DailyMovementValue>;
  private readonly flows: Map<
    string,
    Array<{ currency: string; amount: number }>
  >;
  private readonly holdings: Map<string, Map<string, number>>;
  private readonly priceSeries: PriceSeries;
  private readonly securities: Map<string, MovementSecurity>;

  constructor(input: {
    values: Map<string, DailyMovementValue>;
    flows: Map<string, Array<{ currency: string; amount: number }>>;
    holdings: Map<string, Map<string, number>>;
    priceSeries: PriceSeries;
    securities: Map<string, MovementSecurity>;
    rateIndex: RateIndex;
  }) {
    this.values = input.values;
    this.flows = input.flows;
    this.holdings = input.holdings;
    this.priceSeries = input.priceSeries;
    this.securities = input.securities;
    this.rateIndex = input.rateIndex;
  }

  valueOn(date: string): DailyMovementValue | null {
    return this.values.get(date) ?? null;
  }

  holdingsOn(date: string): Map<string, number> {
    return this.holdings.get(date) ?? new Map();
  }

  security(securityId: string) {
    return this.securities.get(securityId);
  }

  /**
   * A bond-linked security is closed only by the engine's row of the day:
   * a day the engine refused is no close at all, never the previous engine
   * close or one lot's trade price (A26-M26, INV-BOND-010).
   */
  closePointOn(securityId: string, date: string): PricePoint | null {
    return valuationClosePointOn(
      this.securities.get(securityId),
      this.priceSeries.stored.get(securityId),
      this.priceSeries.txFallback.get(securityId),
      date,
    );
  }

  /**
   * A trading day is one on which a security the scope HELD at that close was
   * priced that day -- not merely a day some price row exists for. A position
   * sold last month striking a close today says nothing about this portfolio.
   */
  isTradingDay(date: string): boolean {
    for (const [securityId, quantity] of this.holdingsOn(date)) {
      if (Math.abs(quantity) < QUANTITY_EPSILON) continue;
      const point = this.closePointOn(securityId, date);
      if (point && point.date === date) return true;
    }
    return false;
  }

  /**
   * The day's external flow in the reporting currency. A currency with no rate
   * makes the flow incomplete, which withholds the movement rather than
   * shrinking it.
   */
  flowOn(
    date: string,
    currencyCode: string,
  ): { complete: boolean; value: number } {
    const subtotals = this.flows.get(date) ?? [];
    const folded = foldExternalFlow(subtotals, currencyCode, (currency) => {
      const converted = convertAtDate(
        1,
        currency,
        currencyCode,
        date,
        this.rateIndex,
      );
      return converted;
    });
    return { complete: folded.complete, value: folded.value };
  }
}

/**
 * Held quantities at the close of each day in the window, from one replay.
 *
 * Replayed from the beginning of the ledger (the rows are loaded from the
 * scope's whole history) so a position bought years ago is held today, and
 * snapshotted per day so both endpoints read the same counts.
 */
function replayHoldings(
  rows: ReplayRow[],
  startDate: string,
  endDate: string,
): Map<string, Map<string, number>> {
  const byDate = new Map<string, Map<string, number>>();
  const running = new Map<string, number>();
  let index = 0;

  for (const date of enumerateDaysYMD(startDate, endDate)) {
    while (index < rows.length && rows[index].transaction_date <= date) {
      const row = rows[index];
      if (row.security_id) {
        running.set(
          row.security_id,
          applyActionToQuantity(
            running.get(row.security_id) ?? 0,
            row.action as never,
            Number(row.quantity) || 0,
          ),
        );
      }
      index++;
    }
    byDate.set(date, new Map(running));
  }
  return byDate;
}

/** A day with nothing to report: blank, not unknown. */
function notTradingDay(date: string): DailyMovementPoint {
  return {
    date,
    isTradingDay: false,
    movement: null,
    movementPercent: null,
    complete: false,
    reasons: ["notTradingDay"],
  };
}

const byAbsoluteChangeDesc = (a: SecurityDayMove, b: SecurityDayMove) =>
  Math.abs(b.change ?? b.priceChange) - Math.abs(a.change ?? a.priceChange);
