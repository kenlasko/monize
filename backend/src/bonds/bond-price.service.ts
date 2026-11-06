import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import {
  FetchSyncJob,
  FetchSyncService,
} from "../common/jobs/fetch-sync.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { enumerateDaysYMD } from "../net-worth/series-dates.util";
import { markHoldingAccountsDirty } from "../securities/holding-accounts-dirty.util";
import { invalidatePortfolioSummary } from "../securities/portfolio-summary-memo";
import { loadBondLedger } from "./bond-ledger";
import { BOND_CALENDARS } from "./bond-adapters";
import { BondLot, bondLotsAsOf } from "./bond-lots";
import {
  BondReferenceData,
  BondValuationService,
  financialTodayOf,
} from "./bond-valuation.service";
import { ExactDecimal } from "./domain/exact-decimal";
import { grossValueSeries } from "./engine/bond-engine";
import { marketPriceRequired } from "./engine/price-policy";

import { BOND_ENGINE_PRICE_SOURCE } from "./bond-price-source";

// The source of a row this service writes: the one place the literal is spelled
// (bond-price-source.ts); the upsert and the delete both bind it.
export { BOND_ENGINE_PRICE_SOURCE };

/** The `security_prices.source` of a price the user typed; the engine never replaces it. */
const MANUAL_PRICE_SOURCE = "manual";

/** `security_prices.close_price` is NUMERIC(24,10). */
const PRICE_DECIMALS = 10;

export interface BondPriceRecompute {
  /** Rows inserted or changed. A day whose stored price already agrees is not counted. */
  readonly written: number;
  /** `bond_engine` rows of days that no longer get a price. */
  readonly deleted: number;
}

export interface RecomputeOptions {
  /**
   * The last day priced (YYYY-MM-DD). When omitted: the user's financial today,
   * the calendar date in the timezone the user's preferences name -- the one
   * definition the request and the daily job share (a request's own header
   * would otherwise make the two disagree about the last day).
   */
  readonly today?: string;
}

/**
 * Writes the daily price of a bond-linked security from the bond engine
 * (spec 12.3, 12.4).
 *
 * For each calendar day from the first transaction to today, the unit price is
 * the sum of the open lots' gross values (the lots open ON that day, folded from
 * the ledger up to it) divided by the sum of their quantities, with exact
 * arithmetic, rounded half-up to the column's ten places. The lots of every
 * series the security holds are in the blend, each valued by its own series'
 * terms (`docs/specs/bond-program-securities.md` 2.4). A day on which any
 * open lot has no gross value (a started period without a rate, INV-BOND-002)
 * gets no row, and neither does a day with no open lots or with lots that are
 * unknowable (a split, a fractional or over-removed quantity).
 *
 * Precedence (INV-BOND-005): a transaction-derived price is one lot's trade
 * price, not the holding's value, so the engine's row replaces every non-manual
 * row of its days (a provider row, a transaction-derived row); a manual price is
 * never replaced, and a transaction-derived price never replaces an engine row.
 * An unchanged day is not rewritten. An engine row stores `adjusted_close` NULL:
 * a coupon is recorded as INTEREST income, so the close is the value. Rows of
 * days that no longer get a price are deleted. A security that holds a
 * MARKETABLE series the engine does not price (anything but a discount
 * instrument) gets no engine price at all: the price is the person's
 * (`marketPriceRequired`, `docs/specs/bond-marketable-primitives.md` 3). Reads and writes share one transaction; the derived state
 * (portfolio memo, net-worth snapshots) is invalidated after it commits, never
 * inside it (INV-CACHE-001).
 */
@Injectable()
export class BondPriceService {
  private readonly logger = new Logger(BondPriceService.name);

  /** Far shorter than the daily interval, so a killed replica never blocks tomorrow. */
  private readonly FETCH_LEASE_MS = 30 * 60 * 1000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly valuation: BondValuationService,
    private readonly netWorthService: NetWorthService,
    private readonly fetchSync: FetchSyncService,
  ) {}

  /**
   * Daily, after the benchmark refresh (06:25 on weekdays): accrual moves every
   * calendar day, weekends included, so unlike the refresh this runs every day.
   *
   * Cross-user work with no request behind it, so it seeds its own system
   * context around the whole lease call (`docs/backend/cron-and-background-work.md`).
   * The lease is a cost control: the upserts converge however many replicas run.
   */
  // The timezone is spelled as a literal: cron-doc.spec.ts reads it from the decorator.
  @Cron("45 6 * * *", { timeZone: "Europe/Warsaw" })
  async scheduledRecompute(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.fetchSync.withLease(
          FetchSyncJob.BondPrices,
          this.FETCH_LEASE_MS,
          async () => {
            await this.recomputeAll();
          },
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Scheduled bond price recompute failed: ${message}`);
    }
  }

  /**
   * Every linked security of every user, each user in its own context. One
   * security failing is logged and does not stop the rest. Needs an ambient
   * system identity (`withSystemContext`) for the cross-user listing.
   */
  async recomputeAll(
    options: RecomputeOptions = {},
  ): Promise<{ securities: number; failed: number }> {
    const linked: Array<{ id: string; user_id: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT id, user_id FROM securities
            WHERE bond_program_id IS NOT NULL
            ORDER BY user_id, id`,
        ),
    );

    const byUser = new Map<string, string[]>();
    for (const row of linked) {
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.id]);
    }

    let failed = 0;
    for (const [userId, securityIds] of byUser) {
      try {
        await withUserContext(userId, async () => {
          for (const securityId of securityIds) {
            try {
              await this.recomputeSecurity(userId, securityId, options);
            } catch (error) {
              failed += 1;
              this.logger.error(
                `Bond price recompute failed for security ${securityId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        });
      } catch (error) {
        failed += securityIds.length;
        this.logger.error(
          `Bond price recompute failed for user ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Bond prices recomputed for ${linked.length} linked security/securities, ${failed} failed`,
    );
    return { securities: linked.length, failed };
  }

  /**
   * Recompute one linked security under the caller's identity. `userId` is the
   * owner (from the JWT, or the cron's per-user context); a security that is
   * not this user's, or not linked, is a 404.
   */
  async recomputeSecurity(
    userId: string,
    securityId: string,
    options: RecomputeOptions = {},
  ): Promise<BondPriceRecompute> {
    const { result, accountIds } = await withScopedDb(
      this.dataSource,
      async (m) => {
        // First statement: recomputes of one security, and the unlink that
        // deletes its engine rows, queue here. Everything below reads after the
        // lock is held (a fresh READ COMMITTED snapshot per statement), so the
        // link read next is the link as of now: an unlinked security is a 404
        // and a relinked one is priced from its new instrument.
        await acquireAdvisoryLock(m, LockScope.BondPriceRecompute, securityId);
        const ledger = await loadBondLedger(m, userId, securityId);
        // The reference data of every series the ledger names, once each: the
        // price is the blend over the lots of all of them.
        const references = await this.valuation.loadReferences(
          m,
          new Set(
            ledger.transactions
              .map((t) => t.instrumentId)
              .filter((id): id is string => typeof id === "string"),
          ),
        );
        const today = options.today ?? (await financialTodayOf(m, userId));
        // A security holding a series that trades has no engine price: its
        // price is the person's (INV-BOND-005), and any engine row it had is
        // deleted below as a day that no longer gets a price.
        const prices = marketPriceRequired(
          [...references.values()].map((r) => r.terms),
        )
          ? []
          : this.dailyPrices(ledger.transactions, references, today);

        const written = await this.upsertPrices(m, securityId, prices);
        const deleted = await this.deleteStalePrices(m, securityId, prices);
        const accountIds =
          written + deleted > 0
            ? await markHoldingAccountsDirty(m, securityId, userId)
            : [];
        return { result: { written, deleted }, accountIds };
      },
    );

    // After the commit, never inside it: a recompute started from within would
    // read the rows before they are visible.
    if (result.written + result.deleted > 0) {
      invalidatePortfolioSummary(userId);
      for (const accountId of accountIds) {
        this.netWorthService.triggerDebouncedRecalc(accountId, userId);
      }
    }
    return result;
  }

  /**
   * After the commit of a write that changed lots (an investment transaction
   * created, edited, voided, deleted or transferred; an import; an undo): the
   * engine prices of those of these securities that are linked are recomputed,
   * each in its own transaction. The write is already committed, so a failure is
   * logged and never thrown -- the daily job and the recompute route repair it.
   * Ids that are not this user's, or not linked, are ignored.
   */
  async recomputeLinkedSecurities(
    userId: string,
    securityIds: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    const ids = [...new Set(securityIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    try {
      const linked: Array<{ id: string }> = await withScopedDb(
        this.dataSource,
        (m) =>
          m.query(
            `SELECT id FROM securities
              WHERE id = ANY($1::uuid[]) AND user_id = $2
                AND bond_program_id IS NOT NULL`,
            [ids, userId],
          ),
      );
      for (const { id } of linked) {
        try {
          await this.recomputeSecurity(userId, id);
        } catch (error) {
          this.logger.warn(
            `Bond price recompute of security ${id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Bond price recompute after a ledger write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * After the commit of a series that was stored (a fetch, the current offer, the
   * backfill, an administrator's entry): the engine prices of every security,
   * of every user, linked to a program of these series are recomputed, because a
   * BUY or REINVEST recorded before the series existed is read as the series on
   * sale on its date and its lot only now resolves (INV-CACHE-001: after the
   * commit, never inside it). Reads the securities across users in a system
   * context (ids and owners only) and recomputes each under its owner's. A
   * failure is logged and never thrown: the series is stored, and the daily job
   * and the recompute route repair a price.
   */
  async recomputeLinkedSecuritiesOfSeries(
    instrumentIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(instrumentIds)];
    if (ids.length === 0) return;
    try {
      const linked: Array<{ id: string; user_id: string }> =
        await withSystemContext(() =>
          withScopedDb(this.dataSource, (m) =>
            m.query(
              `SELECT s.id, s.user_id
                 FROM securities s
                WHERE s.bond_program_id IN (
                        SELECT bond_program_id FROM bond_instruments
                         WHERE id = ANY($1::uuid[]))
                ORDER BY s.user_id, s.id`,
              [ids],
            ),
          ),
        );
      const byUser = new Map<string, string[]>();
      for (const row of linked) {
        byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.id]);
      }
      for (const [userId, securityIds] of byUser) {
        await withUserContext(userId, () =>
          this.recomputeLinkedSecurities(userId, securityIds),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Bond price recompute after a stored series failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * The security stops being priced by the engine (unlinked, or linked to another
   * instrument): delete its `bond_engine` rows in the caller's transaction, under
   * the recompute lock so an in-flight recompute of the old link cannot write
   * after this. Rows of any other source (manual, transaction, provider) are not
   * the engine's and stay. Returns the accounts to refresh after the commit.
   */
  async clearEnginePrices(
    m: EntityManager,
    userId: string,
    securityId: string,
  ): Promise<{ deleted: number; accountIds: string[] }> {
    await acquireAdvisoryLock(m, LockScope.BondPriceRecompute, securityId);
    const deleted = await this.deleteStalePrices(m, securityId, []);
    const accountIds =
      deleted > 0 ? await markHoldingAccountsDirty(m, securityId, userId) : [];
    return { deleted, accountIds };
  }

  /** After the commit that cleared a security's engine prices (INV-CACHE-001). */
  publishClearedPrices(userId: string, accountIds: readonly string[]): void {
    invalidatePortfolioSummary(userId);
    for (const accountId of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
  }

  /**
   * The price of every day that has one, ascending. Pure over its inputs.
   *
   * Cost is O(days + lots x periods), not a rate resolution per day: the lots
   * open on each day are folded from the ledger (only on a transaction date),
   * each distinct lot (purchase date and quantity) is valued over all the days
   * it is open in ONE `grossValueSeries` call, which resolves its schedule and
   * period rates once, and the days are then summed from those figures.
   */
  private dailyPrices(
    transactions: Parameters<typeof bondLotsAsOf>[0],
    references: ReadonlyMap<string, BondReferenceData>,
    today: string,
  ): Array<{ date: string; price: string }> {
    const dated = transactions.filter((t) => t.status !== "VOID");
    if (dated.length === 0) return [];
    // Register order puts the earliest date first.
    const first = dated[0].transactionDate;

    // The open lots of every day that has any. Lots change only on a
    // transaction date (the first day is one), so the fold is redone only there
    // and carried over the days between.
    const openOn: Array<{ day: string; lots: readonly BondLot[] }> = [];
    let lots: readonly BondLot[] | null = null;
    const changeDates = new Set(dated.map((t) => t.transactionDate));
    for (const day of enumerateDaysYMD(first, today)) {
      if (changeDates.has(day)) lots = bondLotsAsOf(transactions, day).lots;
      if (lots !== null && lots.length > 0) openOn.push({ day, lots });
    }

    // Each distinct lot and the days it is open on.
    const lotKey = (lot: BondLot) =>
      `${lot.instrumentId ?? ""}|${lot.purchaseDate}|${lot.quantity}|${lot.cost ?? ""}`;
    const daysOf = new Map<string, { lot: BondLot; days: string[] }>();
    for (const { day, lots: open } of openOn) {
      for (const lot of new Set(open.map(lotKey))) {
        const entry = daysOf.get(lot) ?? {
          lot: open.find((l) => lotKey(l) === lot) as BondLot,
          days: [],
        };
        entry.days.push(day);
        daysOf.set(lot, entry);
      }
    }

    // Gross value per distinct lot and day; absent when the lot has none that
    // day (a started period without a rate) or is REFUSED (outside the sale
    // window): either way the day has no price.
    const grossOf = new Map<string, Map<string, string | null>>();
    for (const [key, { lot, days }] of daysOf) {
      const reference = lot.instrumentId
        ? references.get(lot.instrumentId)
        : undefined;
      // A lot whose series has no reference data cannot be valued, and a day
      // holding it gets no price.
      if (!reference) {
        grossOf.set(key, new Map());
        continue;
      }
      const series = grossValueSeries({
        terms: reference.terms,
        termsVersion: reference.termsVersion,
        announcedRates: reference.announcedRates,
        benchmarks: reference.benchmarks,
        calendars: BOND_CALENDARS,
        lot: {
          purchaseDate: lot.purchaseDate,
          quantity: lot.quantity,
          purchaseDateAssumed: lot.purchaseDateAssumed,
          cost: lot.cost,
        },
        days,
      });
      grossOf.set(
        key,
        new Map(
          series.map((point) => [
            point.asOf,
            point.status === "REFUSED" ? null : point.grossValue,
          ]),
        ),
      );
    }

    const prices: Array<{ date: string; price: string }> = [];
    for (const { day, lots: open } of openOn) {
      const price = this.unitPrice(
        open,
        (lot) => (grossOf.get(lotKey(lot)) ?? new Map()).get(day) ?? null,
      );
      if (price !== null) prices.push({ date: day, price });
    }
    return prices;
  }

  /** Gross value of the open lots per bond, or null when any lot has none. */
  private unitPrice(
    lots: readonly BondLot[],
    grossOf: (lot: BondLot) => string | null,
  ): string | null {
    let total = ExactDecimal.ZERO;
    let quantity = 0;
    for (const lot of lots) {
      const grossValue = grossOf(lot);
      if (grossValue === null) return null;
      total = total.add(ExactDecimal.parse(grossValue));
      quantity += lot.quantity;
    }
    return total.div(ExactDecimal.fromInt(quantity)).toFixed(PRICE_DECIMALS);
  }

  /**
   * One statement. The `WHERE` is the whole rule: every row except a `manual`
   * one is replaced (a provider row, a transaction-derived row, the engine's own
   * earlier value), and only when something differs, so an unchanged day is not
   * rewritten. A transaction price is one lot's trade price, not the holding's
   * value; a manual price is the user's correction and always wins.
   */
  private async upsertPrices(
    m: EntityManager,
    securityId: string,
    prices: ReadonlyArray<{ date: string; price: string }>,
  ): Promise<number> {
    if (prices.length === 0) return 0;
    const rows: unknown = await m.query(
      // adjusted_close NULL: coupons are recorded as INTEREST income, so the
      // close is the value and there is nothing to adjust for. A conflicting row
      // gets NULL too, so a provider's adjusted close does not outlive its close.
      `INSERT INTO security_prices (security_id, price_date, close_price, adjusted_close, source)
       SELECT $1::uuid, t.d, t.p, NULL, $4::varchar
         FROM unnest($2::date[], $3::numeric[]) AS t(d, p)
       ON CONFLICT (security_id, price_date) DO UPDATE
          SET close_price = EXCLUDED.close_price,
              adjusted_close = NULL,
              source = EXCLUDED.source
        WHERE security_prices.source IS DISTINCT FROM $5::varchar
          AND (security_prices.close_price IS DISTINCT FROM EXCLUDED.close_price
               OR security_prices.source IS DISTINCT FROM EXCLUDED.source
               OR security_prices.adjusted_close IS NOT NULL)
       RETURNING id`,
      [
        securityId,
        prices.map((p) => p.date),
        prices.map((p) => p.price),
        BOND_ENGINE_PRICE_SOURCE,
        MANUAL_PRICE_SOURCE,
      ],
    );
    return returnedRows<{ id: number }>(rows).length;
  }

  private async deleteStalePrices(
    m: EntityManager,
    securityId: string,
    prices: ReadonlyArray<{ date: string }>,
  ): Promise<number> {
    const rows: unknown = await m.query(
      `DELETE FROM security_prices
        WHERE security_id = $1
          AND source = $3::varchar
          AND NOT (price_date = ANY($2::date[]))
       RETURNING id`,
      [securityId, prices.map((p) => p.date), BOND_ENGINE_PRICE_SOURCE],
    );
    return returnedRows<{ id: number }>(rows).length;
  }
}
