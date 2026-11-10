import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { mapWithConcurrency } from "../common/concurrency.util";
import { FxAggregate } from "../common/fx-aggregate";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { preferredCurrency } from "../common/default-currency.util";
import {
  RateIndex,
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import { calendarRangeDays } from "../common/validators/calendar-range.validator";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "./accounts.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { BalanceForecastGap } from "./balance-forecast.util";
import { enumerateDaysYMD } from "../net-worth/series-dates.util";

/** One day of the range, as the calendar's Balances layer reads it. */
export interface DailyBalanceTotalPoint {
  date: string;
  /**
   * The scope's end-of-day total in `currencyCode`, or `null` when any
   * component is unknown -- an unconverted account on a history day, or an
   * account whose projection was withheld on a projected day.
   *
   * `null` is not zero and zero is not `null`: a scope of emptied accounts
   * totals a known 0.00.
   */
  total: number | null;
  /**
   * The sum of the components that WERE known. Equal to `total` when the total
   * is known; otherwise a subtotal, which may only be shown under a caption
   * that says so (`docs/financial-calculation-contract.md` section 1).
   */
  knownSubtotal: number;
  /** `date > today`, decided by the server's day and echoed as `today`. */
  isProjected: boolean;
  /**
   * `"USD->CAD"` for each pair that could not be resolved on this day. A
   * history day asks for that day's rate; a projected day asks for today's,
   * because the day it is about has no rate yet.
   */
  missingRatePairs: string[];
}

export interface DailyBalanceTotalsResponse {
  startDate: string;
  endDate: string;
  /** The server's financial today; `isProjected` is decided from it. */
  today: string;
  /** The one currency every scoped account shares, else the display currency. */
  currencyCode: string;
  days: DailyBalanceTotalPoint[];
  forecast: {
    /** False withholds `total` on EVERY projected day. */
    complete: boolean;
    /** The schedules that made it incomplete, unioned over the scope. */
    gaps: BalanceForecastGap[];
    /**
     * Accounts in scope this caller cannot be given a projection for -- today,
     * a joint account, whose forecast belongs to its owner's identity. Named
     * rather than dropped: withholding a figure is only honest if the reader
     * learns why, and these accounts have no schedule to blame.
     */
    unforecastableAccountIds: string[];
  };
  /** Empty scope: no account matched, so there is nothing to total. */
  scopeEmpty: boolean;
}

/**
 * How many accounts are forecast at once.
 *
 * `getBalanceForecast` is four round trips in four transactions for an account
 * with no schedules and six for one with them, so a twenty-account month walked
 * serially was a hundred round trips on a request the calendar fires on every
 * month change. Bounded rather than `Promise.all`: each call opens its own
 * scoped transaction, and the pool is shared with every other request on this
 * replica.
 */
const FORECAST_CONCURRENCY = 5;

/** One row of `AccountsService.getDailyBalances`. */
export interface DailyAccountBalance {
  date: string;
  balance: number;
  accountId: string;
  currencyCode: string;
}

/** A {@link DailyAccountBalance} with its value in the reporting currency. */
export interface DailyAccountBalanceConverted extends DailyAccountBalance {
  /** The reader's reporting currency, which `convertedBalance` is in. */
  convertedCurrency: string;
  /** The balance at the day's own rate (today's for a future day), or null. */
  convertedBalance: number | null;
}

/** One scoped account, as both halves of the answer need it. */
interface ScopedAccount {
  id: string;
  currencyCode: string;
  /** False for a joint account the caller does not own (see `unforecastableAccountIds`). */
  owned: boolean;
}

/**
 * The scope's end-of-day total for every day of a calendar month grid: actual
 * through today, projected after it.
 *
 * This is a read model over two services that already own their halves, and it
 * adds no arithmetic of its own beyond the summation:
 *
 *  - **History** is `AccountsService.getDailyBalances` -- the same ledger sum
 *    under `LEDGER_MOVEMENT_PREDICATE` the register's balance column draws, so a
 *    single-account calendar agrees with its register to the cent.
 *  - **Projection** is `BalanceForecastService.getBalanceForecast` per account,
 *    including its withhold rule: one occurrence nobody can price makes every
 *    point after it wrong, so that account's series is withheld whole and its
 *    gaps are named (issue #1247).
 *
 * `currentBalance` is never read on either side. Conversion is
 * `FxAggregate` over the shared rate index, so a day with an unconvertible
 * account reports `total: null` with the pair named, never a subtotal under a
 * field called "total" (INV-FX-001).
 */
@Injectable()
export class DailyBalanceTotalsService {
  private readonly logger = new Logger(DailyBalanceTotalsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly accountsService: AccountsService,
    private readonly balanceForecastService: BalanceForecastService,
  ) {}

  /**
   * `accountIds` is the scope the controller already authorized: for an acting
   * delegate it has been narrowed to their readable accounts, and
   * `jointAccountIds` carries the joint grants that widen the ownership
   * predicate, exactly as `daily-balances` does. Omitted means every open
   * account the caller can see.
   */
  async getDailyBalanceTotals(
    userId: string,
    startDate: string,
    endDate: string,
    accountIds?: string[],
    displayCurrency?: string,
    jointAccountIds: string[] = [],
  ): Promise<DailyBalanceTotalsResponse> {
    const today = todayYMD();
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const fallbackCurrency = displayCurrency || preferredCurrency(pref);

    const scope = await this.resolveScope(userId, accountIds, jointAccountIds);
    const dates = enumerateDaysYMD(startDate, endDate);

    if (scope.length === 0) {
      return {
        startDate,
        endDate,
        today,
        currencyCode: fallbackCurrency,
        days: dates.map((date) => ({
          date,
          total: null,
          knownSubtotal: 0,
          isProjected: date > today,
          missingRatePairs: [],
        })),
        forecast: { complete: true, gaps: [], unforecastableAccountIds: [] },
        scopeEmpty: true,
      };
    }

    // A scope in one currency converts nothing, and its report names that
    // currency rather than the user's preference: this is what makes a single
    // account's calendar agree with its own register's balance column.
    const scopeCurrencies = new Set(scope.map((a) => a.currencyCode));
    const currencyCode =
      scopeCurrencies.size === 1 ? [...scopeCurrencies][0] : fallbackCurrency;

    const historyEnd = endDate <= today ? endDate : today;
    const projectionStart =
      startDate > today ? startDate : addDaysYMD(today, 1);

    const rateIndex = await this.loadRates(
      scope,
      currencyCode,
      startDate,
      endDate,
      today,
    );

    const history =
      startDate <= today
        ? await this.historyByDate(
            userId,
            startDate,
            historyEnd,
            scope,
            jointAccountIds,
          )
        : new Map<string, Map<string, number>>();

    const projection =
      endDate > today
        ? await this.projectionByDate(userId, scope, projectionStart, endDate)
        : {
            byAccount: new Map<string, Map<string, number>>(),
            complete: true,
            gaps: [] as BalanceForecastGap[],
            unforecastableAccountIds: [] as string[],
          };

    const days = dates.map((date) => {
      const isProjected = date > today;
      const aggregate = new FxAggregate();
      // A projection is priced at today's rate: the day it is about has no rate
      // yet, and reaching for the nearest one would report a forecast at a rate
      // nobody ever struck.
      const rateDate = isProjected ? today : date;

      for (const account of scope) {
        const balances = isProjected
          ? projection.byAccount.get(account.id)
          : history.get(account.id);
        const balance = balances?.get(date);
        if (balance === undefined) {
          // Either the account's projection was withheld whole, or it has no
          // row for a day the series should have covered. Unknown, with no
          // currency pair to blame.
          aggregate.addUnknown();
          continue;
        }
        aggregate.add(
          convertAtDate(
            balance,
            account.currencyCode,
            currencyCode,
            rateDate,
            rateIndex,
            this.logger,
          ),
          account.currencyCode,
          currencyCode,
        );
      }

      return {
        date,
        total: aggregate.total,
        knownSubtotal: aggregate.knownSubtotal,
        isProjected,
        missingRatePairs: aggregate.missingPairs,
      };
    });

    return {
      startDate,
      endDate,
      today,
      currencyCode,
      days,
      forecast: {
        complete: projection.complete,
        gaps: projection.gaps,
        unforecastableAccountIds: projection.unforecastableAccountIds,
      },
      scopeEmpty: false,
    };
  }

  /**
   * Each per-account daily balance with its value in the reader's reporting
   * currency beside it, for a reader that totals accounts of several
   * currencies (the Transactions page's balance line).
   *
   * A history day converts at that day's rate and a projected day at today's,
   * the same rule as {@link getDailyBalanceTotals}. Converting the whole series
   * at today's rate read a currency's move since a day as a move in the
   * balance (issue #2106). A row with no admissible rate carries
   * `convertedBalance: null`, never its own amount.
   */
  async withReportingCurrency(
    userId: string,
    rows: ReadonlyArray<DailyAccountBalance>,
  ): Promise<DailyAccountBalanceConverted[]> {
    if (rows.length === 0) return [];
    const today = todayYMD();
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const currencyCode = preferredCurrency(pref);
    const currencies = new Set(
      rows.map((r) => r.currencyCode).filter((code) => code !== currencyCode),
    );
    const dates = rows.map((r) => r.date).sort();
    const rateIndex =
      currencies.size === 0
        ? new Map()
        : await this.loadRateIndex(
            currencies,
            currencyCode,
            dates[0],
            dates[dates.length - 1],
            today,
          );
    return rows.map((row) => ({
      ...row,
      convertedCurrency: currencyCode,
      convertedBalance:
        row.currencyCode === currencyCode
          ? row.balance
          : convertAtDate(
              row.balance,
              row.currencyCode,
              currencyCode,
              row.date > today ? today : row.date,
              rateIndex,
              this.logger,
            ),
    }));
  }

  /**
   * The accounts to total, with the currency each one's balance is in.
   *
   * Resolved explicitly rather than left to `getDailyBalances`'s "no ids means
   * everything", because both halves need the same list: the projection asks
   * per account, and the currency set decides what the totals are reported in.
   * Closed accounts are out of scope -- their balance is settled and a closed
   * account on every day of the grid is noise.
   */
  private async resolveScope(
    userId: string,
    accountIds: string[] | undefined,
    jointAccountIds: string[],
  ): Promise<ScopedAccount[]> {
    const idsParam = accountIds && accountIds.length > 0 ? accountIds : null;
    const rows: Array<{
      id: string;
      currency_code: string;
      owned: boolean;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT id, currency_code, (user_id = $1) AS owned
           FROM accounts
          WHERE (user_id = $1 OR id = ANY($3::UUID[]))
            AND ($2::UUID[] IS NULL OR id = ANY($2::UUID[]))
            AND is_closed = false
          ORDER BY id`,
        [userId, idsParam, jointAccountIds],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      currencyCode: r.currency_code,
      owned: r.owned === true,
    }));
  }

  /**
   * Every rate the range can need, in one query: the day's own rate for the
   * history half and today's for the projection half, which is why `today` is
   * inside the loaded window even when it sits outside the requested range.
   */
  private loadRates(
    scope: ScopedAccount[],
    currencyCode: string,
    startDate: string,
    endDate: string,
    today: string,
  ): Promise<RateIndex> {
    const currencies = new Set(
      scope.map((a) => a.currencyCode).filter((code) => code !== currencyCode),
    );
    return this.loadRateIndex(
      currencies,
      currencyCode,
      startDate,
      endDate,
      today,
    );
  }

  /** {@link loadRates} for an explicit set of currencies. */
  private loadRateIndex(
    currencies: Set<string>,
    currencyCode: string,
    startDate: string,
    endDate: string,
    today: string,
  ): Promise<RateIndex> {
    const from = startDate < today ? startDate : today;
    const to = endDate > today ? endDate : today;
    return buildRateIndex(
      (sql, params) =>
        withScopedDb(this.dataSource, (m) => m.query(sql, params)),
      currencies,
      currencyCode,
      from,
      to,
    );
  }

  /** Per-account end-of-day ledger balances, keyed account -> date -> balance. */
  private async historyByDate(
    userId: string,
    startDate: string,
    endDate: string,
    scope: ScopedAccount[],
    jointAccountIds: string[],
  ): Promise<Map<string, Map<string, number>>> {
    const rows = await this.accountsService.getDailyBalances(
      userId,
      startDate,
      endDate,
      scope.map((a) => a.id),
      false,
      jointAccountIds,
    );
    const byAccount = new Map<string, Map<string, number>>();
    for (const row of rows) {
      let dates = byAccount.get(row.accountId);
      if (!dates) {
        dates = new Map();
        byAccount.set(row.accountId, dates);
      }
      dates.set(row.date, row.balance);
    }
    return byAccount;
  }

  /**
   * Per-account projected balances for every day after today, forward-filled.
   *
   * The forecast emits a point at today plus one per day something moves, so a
   * day with no occurrence carries the last point's balance -- that IS the
   * projection for that day, not a missing value. An account whose forecast is
   * incomplete contributes no map at all, which lands as `addUnknown()` at the
   * summation and withholds the total for every projected day.
   */
  private async projectionByDate(
    userId: string,
    scope: ScopedAccount[],
    projectionStart: string,
    endDate: string,
  ): Promise<{
    byAccount: Map<string, Map<string, number>>;
    complete: boolean;
    gaps: BalanceForecastGap[];
    unforecastableAccountIds: string[];
  }> {
    const today = todayYMD();
    const horizonDays = Math.max(1, calendarRangeDays(today, endDate) - 1);
    const projectedDates = enumerateDaysYMD(projectionStart, endDate);

    const byAccount = new Map<string, Map<string, number>>();
    const gaps: BalanceForecastGap[] = [];
    const unforecastableAccountIds: string[] = [];
    let complete = true;

    // A joint account's forecast reads schedules that belong to its owner's
    // identity, which this request does not carry. Named, not guessed at.
    const owned = scope.filter((account) => account.owned);
    for (const account of scope) {
      if (!account.owned) {
        unforecastableAccountIds.push(account.id);
        complete = false;
      }
    }

    const forecasts = await mapWithConcurrency(
      owned,
      FORECAST_CONCURRENCY,
      (account) =>
        this.balanceForecastService.getBalanceForecast(
          userId,
          account.id,
          horizonDays,
        ),
    );

    // Merged in `owned` order, which is `resolveScope`'s `ORDER BY id`, so the
    // gap list a caller sees does not depend on which forecast finished first.
    owned.forEach((account, index) => {
      const forecast = forecasts[index];
      if (!forecast.complete) {
        complete = false;
        for (const gap of forecast.gaps) {
          if (
            !gaps.some(
              (g) => g.scheduledTransactionId === gap.scheduledTransactionId,
            )
          ) {
            gaps.push(gap);
          }
        }
        return;
      }

      byAccount.set(account.id, forwardFill(forecast.points, projectedDates));
    });

    return { byAccount, complete, gaps, unforecastableAccountIds };
  }
}

/**
 * The forecast's sparse points spread over every requested day: each day takes
 * the most recent point on or before it. A day before the first point has no
 * value, which is a genuine unknown rather than a zero.
 */
function forwardFill(
  points: Array<{ date: string; balance: number }>,
  dates: string[],
): Map<string, number> {
  const filled = new Map<string, number>();
  let index = 0;
  let current: number | undefined;
  for (const date of dates) {
    while (index < points.length && points[index].date <= date) {
      current = points[index].balance;
      index++;
    }
    if (current !== undefined) filled.set(date, current);
  }
  return filled;
}
