import {
  BadRequestException,
  Injectable,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { FUNDING_ACCOUNT_ACTIONS } from "../securities/investment-replay.util";
import {
  investmentSplitCashAmount,
  computeInvestmentCashImpact,
} from "../securities/cash-impact.util";
import { AMOUNT_ONLY_ACTIONS } from "./scheduled-investment-actions";
import {
  FIAT_MONEY_DECIMALS,
  MONEY_SCALE,
  roundMoney,
  sumMoney,
} from "../common/round.util";
import { mapWithConcurrency } from "../common/concurrency.util";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";

/**
 * Bound on how many scheduled rows resolve their #1167 forecast FX concurrently
 * in one read (issue #1167 review). Rows are independent and the pair/rate/tuple
 * caches store Promises and are populated with a synchronous get->set (no await
 * between), so concurrent rows join the same in-flight work rather than
 * duplicating a provider fetch or a pair derivation. The cap keeps distinct
 * currency pairs from serializing their external FX lookups end-to-end while
 * staying within provider limits, matching the fan-out bound the FX subsystem
 * already uses.
 */
export const SCHEDULED_FORECAST_CONCURRENCY = 6;

/**
 * The cash amount one scheduled occurrence would post *today*, and whether that
 * is actually known (issue #1247).
 *
 * `amount` is `null` exactly when a component of it is unknown -- today the only
 * such component is a cross-currency settlement rate that cannot be resolved.
 * `null` never means "fall back to the persisted `ScheduledTransaction.amount`":
 * that scalar is a snapshot taken at whatever rate was current when it was
 * written, and presenting it as the current amount is the defect this type
 * exists to prevent. A consumer either renders the value as unavailable or
 * withholds the total it belongs to.
 *
 * `currencyCode` is the currency `amount` is expressed in. For a top-level
 * investment schedule that is the *settlement* currency (the funding-or-linked
 * cash account's), not the brokerage account's `currencyCode` -- the stored
 * `amount` is the security-currency cash impact and the effective amount is that
 * impact converted, exactly as the cash-flow forecast projects it.
 */
export interface EffectiveScheduledAmount {
  amount: number | null;
  currencyCode: string;
  /** `amount !== null`. A total containing an incomplete item is incomplete. */
  complete: boolean;
  /**
   * The signed amount that decides DIRECTION -- outflow or inflow -- or `null`
   * when the direction itself cannot be derived.
   *
   * `amount` whenever it is known. When it is not, the stored scalar's sign
   * stands in only where that sign is *provable* without the missing rate:
   *
   *  - a top-level investment schedule is one scalar times one rate, and a rate
   *    is positive, so the sign cannot move;
   *  - a split whose lines all point the same way stays on that side of zero,
   *    because an investment line's own cash impact is signed by its ACTION
   *    (a BUY removes cash at any rate) and the rate only scales the magnitude.
   *
   * A **mixed-sign** aggregate is the case where it is not provable, and it is
   * the case the whole `directionAmount` idea exists for: a +10 parent made of a
   * fixed +100 beside an unpriceable BUY posts -20 at one rate and +20 at
   * another, a 40 swing across zero. Copying the parent's `+10` there asserts a
   * deposit the data cannot support, so this is `null` and every consumer says
   * "unknown" rather than picking a side.
   */
  directionAmount: number | null;
}

/** The effective amount for one per-occurrence override. */
export interface OverrideEffectiveAmount {
  /**
   * The #1167 read-model field: the effective total an investment-carrying
   * override would post today. `undefined` when the override carries no
   * investment at all (its own stored `amount` stands), `null` when it is
   * investment-related but the current rate is unknown.
   */
  investmentForecastAmount: number | null | undefined;
  effective: EffectiveScheduledAmount;
}

/** Everything the effective-amount contract says about one schedule. */
export interface ScheduledEffectiveAmounts {
  /** The base schedule's occurrences (every occurrence with no override). */
  base: EffectiveScheduledAmount;
  /**
   * The account the occurrence's cash actually moves through, and therefore the
   * account whose balance `base.amount` belongs to (issue #1247).
   *
   * For a top-level investment schedule that is the *settlement* account -- the
   * named funding account, or the brokerage's linked cash account -- not
   * `accountId`, which is the brokerage. An account-level projection keyed on
   * `accountId` charged the brokerage for cash it never moved and left the
   * funding account's own chart missing the outflow it pays. For every other
   * schedule it is `accountId` unchanged.
   *
   * `base.currencyCode` is this account's currency by construction, which is what
   * makes it safe to add to that account's running balance.
   */
  settlementAccountId: string;
  /**
   * The settlement currency pair a top-level investment schedule converts across,
   * or `null` where there is no single pair to name -- a non-investment schedule,
   * or a split parent whose investment lines each settle their own security's
   * currency.
   *
   * Carried so a consumer that has to report an unresolvable rate can say WHICH
   * pair failed rather than only that something did: "no rate from USD to CAD"
   * is a sentence the reader can act on, "the amount is unavailable" is not
   * (issue #1247).
   */
  settlementPair: { from: string; to: string } | null;
  /**
   * The FX rate the forecast and the posting would apply to a top-level
   * investment schedule (issue #1167). `null` for a non-investment schedule and
   * for an investment schedule whose current rate is unknown.
   */
  investmentForecastExchangeRate: number | null;
  /**
   * The re-summed effective total of an embedded-investment-split schedule
   * (issue #1167). `null` for a schedule carrying no investment split, and for
   * one where any investment line's current rate is unknown.
   */
  investmentForecastAmount: number | null;
  /** Per-override effective amounts, keyed by {@link overrideEffectiveKey}. */
  overrides: Map<string, OverrideEffectiveAmount>;
}

type ScheduledRowWithOverrides = ScheduledTransaction & {
  nextOverride?: ScheduledTransactionOverride | null;
  futureOverrides?: ScheduledTransactionOverride[];
};

/**
 * The key an override's effective amount is filed under. The id is the identity
 * where there is one; a fixture or a hand-built next-override without one falls
 * back to its original date, which is unique per schedule by construction (the
 * `(scheduled_transaction_id, original_date)` unique index).
 */
export function overrideEffectiveKey(override: {
  id?: string | null;
  originalDate?: string | Date | null;
}): string {
  if (override.id) return override.id;
  return `date:${override.originalDate ? ensureYMD(override.originalDate as string) : ""}`;
}

/**
 * The one server-side answer to "what would this scheduled occurrence actually
 * post today, and do we know?" (issue #1247).
 *
 * Issue #1167 established that a scheduled investment's persisted FX rate stops
 * describing the settlement pair as soon as the referenced security's or
 * account's currency changes, and that the cash-flow forecast must therefore
 * project a *re-resolved* amount. That decision was made inside the scheduled
 * list read and consumed by one surface. Every other consumer -- AI, MCP,
 * dashboard, budget, reports, exports -- went on reading the persisted
 * `ScheduledTransaction.amount`, so one schedule answered 1,500 CAD on five
 * screens and 1,350 CAD on the forecast that predicts its posting.
 *
 * This service is that decision, extracted: the provenance rules, the
 * stored-if-current-else-resolve precedence, the per-read FX caches, and the
 * combination of rate and stored scalar into an amount. Consumers ask for
 * {@link resolveMany} and read {@link EffectiveScheduledAmount}; none of them
 * re-derives FX, and none of them may substitute the persisted scalar for an
 * unknown one.
 */
@Injectable()
export class ScheduledEffectiveAmountService {
  constructor(
    @Inject(forwardRef(() => InvestmentTransactionsService))
    private investmentTransactionsService: InvestmentTransactionsService,
  ) {}

  /**
   * The effective amount for every schedule in `rows`, plus every override each
   * row carries (`nextOverride` and `futureOverrides` when the caller hydrated
   * them, otherwise `overrides`).
   *
   * The FX caches are created here and live for exactly this call, so one read
   * asks the provider once per currency pair and derives each settlement tuple
   * once. Rows resolve with bounded concurrency and the returned map is keyed by
   * schedule id, so the caller's ordering is its own business.
   *
   * The provider-capable rate path can perform an external fetch and persist the
   * result, so callers must run this **outside** any long read transaction.
   */
  async resolveMany(
    userId: string,
    rows: ScheduledRowWithOverrides[],
    asOf: Date = new Date(),
  ): Promise<Map<string, ScheduledEffectiveAmounts>> {
    // Dedup the settlement-pair FX fetch across EVERY forecast resolver within
    // one read (issue #1167 review R14-F1). The parent rate, the
    // split-investment amount and each override amount all resolve an unchanged
    // pair through the same external `resolveCashExchangeRateOrNull`, and a pair
    // that does not resolve persists nothing -- so without this shared negative
    // cache each of N schedules on the same unfetchable pair re-hits the FX
    // provider on every read. Keyed on the settlement pair (`asOf` is constant
    // across the read). A same-currency row short-circuits to 1 with no lookup.
    const pairRateCache = new Map<string, Promise<number | null>>();
    // Dedup the settlement-pair DERIVATION (2-3 DB reads each) across every
    // forecast resolver in this read (issue #1167 review): the stored-current
    // check, the pair-rate cache key and the effective currency all derive the
    // same tuple's pair, so without this memo a user with many investment
    // schedules sharing one settlement tuple pays O(rows) identical
    // account/security lookups even when every rate is already cached.
    const pairCache = new Map<string, Promise<{ from: string; to: string }>>();
    // A second, higher-level memo for the parent rate: dedups the stored-current
    // decision as well as the fetch, so two rows with the same settlement tuple,
    // stored rate/pair and action resolve once. It shares `pairRateCache` for the
    // fetch, so the parent path and the amount paths never fetch the same pair
    // twice.
    const forecastRateCache = new Map<string, Promise<number | null>>();
    // The settlement-ACCOUNT derivation, memoized per tuple for the same reason
    // the pair is: it is 1-2 account reads and every row sharing a tuple asks the
    // identical question (issue #1247).
    const accountCache = new Map<string, Promise<string>>();
    const forecastRateFor = (
      row: ScheduledTransaction,
    ): Promise<number | null> => {
      if (!(row.isInvestment && row.investmentAction)) {
        return Promise.resolve(null);
      }
      const key = [
        row.accountId,
        row.investmentFundingAccountId ?? "",
        row.investmentSecurityId ?? "",
        row.investmentExchangeRate ?? "",
        row.investmentExchangeRateFromCurrency ?? "",
        row.investmentExchangeRateToCurrency ?? "",
        row.investmentAction,
      ].join("|");
      let pending = forecastRateCache.get(key);
      if (!pending) {
        pending = this.resolveInvestmentForecastRate(
          userId,
          row,
          asOf,
          pairRateCache,
          pairCache,
        );
        forecastRateCache.set(key, pending);
      }
      return pending;
    };

    const resolved = await mapWithConcurrency(
      rows,
      SCHEDULED_FORECAST_CONCURRENCY,
      async (row) => {
        const investmentForecastExchangeRate = await forecastRateFor(row);
        // A split-investment schedule projects its *effective* total (re-summed
        // with current FX) rather than the stored parent amount (issue #1167);
        // null for every other schedule leaves the amount on `amount`.
        const investmentForecastAmount =
          await this.resolveInvestmentForecastSplitAmount(
            userId,
            row,
            asOf,
            pairRateCache,
            pairCache,
          );
        const base = await this.baseEffectiveAmount(
          userId,
          row,
          investmentForecastExchangeRate,
          investmentForecastAmount,
          pairCache,
        );
        const settlementAccountId = await this.settlementAccountFor(
          userId,
          row,
          accountCache,
        );
        const settlementPair = await this.settlementPairFor(
          userId,
          row,
          pairCache,
        );

        // Prefer the overrides the caller hydrated for the projection
        // (`futureOverrides` / `nextOverride`); fall back to the plain relation
        // for a caller that loaded that instead. An empty `futureOverrides` is a
        // hydrated answer of "none", not an invitation to read the relation.
        const hydrated =
          row.futureOverrides !== undefined || row.nextOverride !== undefined;
        const overrideRows = hydrated
          ? [
              ...(row.futureOverrides ?? []),
              ...(row.nextOverride ? [row.nextOverride] : []),
            ]
          : (row.overrides ?? []);
        const overrides = new Map<string, OverrideEffectiveAmount>();
        for (const override of overrideRows) {
          const key = overrideEffectiveKey(override);
          if (overrides.has(key)) continue;
          const investmentAmount =
            await this.resolveOverrideInvestmentForecastAmount(
              userId,
              row,
              override,
              asOf,
              pairRateCache,
              pairCache,
            );
          overrides.set(key, {
            investmentForecastAmount: investmentAmount,
            effective: this.overrideEffectiveAmount(
              override,
              investmentAmount,
              base,
            ),
          });
        }

        return {
          id: row.id,
          value: {
            base,
            settlementAccountId,
            settlementPair,
            investmentForecastExchangeRate,
            investmentForecastAmount,
            overrides,
          } satisfies ScheduledEffectiveAmounts,
        };
      },
    );

    return new Map(resolved.map((r) => [r.id, r.value]));
  }

  /**
   * The effective amount of a single schedule, for a caller holding one row.
   * Convenience over {@link resolveMany}; the caches it would share are of no
   * use to one row.
   */
  async resolveOne(
    userId: string,
    row: ScheduledRowWithOverrides,
    asOf: Date = new Date(),
  ): Promise<ScheduledEffectiveAmounts> {
    const resolved = await this.resolveMany(userId, [row], asOf);
    return resolved.get(row.id)!;
  }

  /**
   * The amount every un-overridden occurrence of `row` would post today.
   *
   *   - **top-level investment**: the stored security-currency cash impact
   *     converted at the effective settlement rate, in the settlement currency.
   *     Unknown when that rate is unknown -- never the stored scalar, which is
   *     the security-currency figure and would read as a settlement-currency one.
   *   - **embedded investment splits**: the server's re-summed effective total.
   *     Unknown when any line's current rate is unknown.
   *   - **anything else** (plain, transfer, non-investment split): the stored
   *     `amount`, which no FX rate re-prices. Known.
   *
   * This is by definition the figure the cash-flow projection shows: the client's
   * `frontend/src/lib/forecast.ts` folds the same rate into the same scalar. It
   * keeps doing so because a projection needs more than the amount (the cash
   * account remap, per-override conversion, withholding a cumulative series), but
   * the arithmetic must stay identical -- the two answering differently is the
   * defect issue #1247 exists to close.
   */
  private async baseEffectiveAmount(
    userId: string,
    row: ScheduledTransaction,
    investmentForecastExchangeRate: number | null,
    investmentForecastAmount: number | null,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<EffectiveScheduledAmount> {
    if (row.isInvestment) {
      const currencyCode = await this.settlementCurrencyFor(
        userId,
        row,
        pairCache,
      );
      if (investmentForecastExchangeRate === null) {
        // One scalar times one rate, and a rate is positive: the magnitude is
        // unknown but the SIDE of zero is not.
        return {
          amount: null,
          currencyCode,
          complete: false,
          directionAmount: Number(row.amount),
        };
      }
      // A top-level investment's cash is brokerage cash, fiat by
      // INV-CRYPTO-001, so it rounds at the fiat precision.
      const amount = roundMoney(
        Number(row.amount) * investmentForecastExchangeRate,
        FIAT_MONEY_DECIMALS,
      );
      return {
        amount,
        currencyCode,
        complete: true,
        directionAmount: amount,
      };
    }
    if (hasEmbeddedInvestmentSplits(row)) {
      if (investmentForecastAmount === null) {
        // A mixed-sign parent's direction is decided by the missing rate, so it
        // is unknown; a same-signed one stays on its side whatever the rate is.
        const provable = signIsProvable(splitLineSigns(row.splits ?? []));
        return {
          amount: null,
          currencyCode: row.currencyCode,
          complete: false,
          directionAmount: provable ? Number(row.amount) : null,
        };
      }
      return {
        amount: investmentForecastAmount,
        currencyCode: row.currencyCode,
        complete: true,
        directionAmount: investmentForecastAmount,
      };
    }
    // A stored amount was held to its currency's precision when written
    // (INV-MONEY-001), so normalizing it at the column scale is the identity
    // on it: a coin keeps its satoshis, and the figure is the one posting
    // will write, as given.
    const stored = roundMoney(Number(row.amount), MONEY_SCALE);
    return {
      amount: stored,
      currencyCode: row.currencyCode,
      complete: true,
      directionAmount: stored,
    };
  }

  /**
   * The amount one overridden occurrence would post today.
   *
   * Mirrors the precedence the posting path applies: an investment-related
   * override (a top-level investment schedule's override, or an override
   * carrying investment splits) posts its recomputed effective total; any other
   * override posts its own stored scalar; an override that carries no amount of
   * its own falls through to the base occurrence, inheriting its completeness.
   */
  private overrideEffectiveAmount(
    override: ScheduledTransactionOverride,
    investmentForecastAmount: number | null | undefined,
    base: EffectiveScheduledAmount,
  ): EffectiveScheduledAmount {
    if (investmentForecastAmount !== undefined) {
      if (investmentForecastAmount === null) {
        // Same rule as the base: the sign survives a missing rate only where the
        // parts agree. A top-level investment override is one scalar times one
        // rate; an investment-carrying override split is provable only if its own
        // lines point the same way.
        const provable = override.isSplit
          ? signIsProvable(splitLineSigns(overrideSplitLines(override)))
          : true;
        const scalar =
          override.amount !== null && override.amount !== undefined
            ? Number(override.amount)
            : base.directionAmount;
        return {
          amount: null,
          currencyCode: base.currencyCode,
          complete: false,
          directionAmount: provable ? scalar : null,
        };
      }
      return {
        amount: investmentForecastAmount,
        currencyCode: base.currencyCode,
        complete: true,
        directionAmount: investmentForecastAmount,
      };
    }
    if (override.amount !== null && override.amount !== undefined) {
      // As the stored base amount: already at its currency's precision.
      const own = roundMoney(Number(override.amount), MONEY_SCALE);
      return {
        amount: own,
        currencyCode: base.currencyCode,
        complete: true,
        directionAmount: own,
      };
    }
    return base;
  }

  /**
   * The currency a schedule's effective amount is expressed in: the settlement
   * account's currency for an investment schedule (the `to` side of the pair its
   * rate converts across), the schedule's own `currencyCode` otherwise.
   *
   * Derived through the memoized pair resolver, which every rate path on the same
   * row already went through, so this adds no reads within one `resolveMany`.
   * A schedule whose action is missing has no settlement pair to speak of, so it
   * keeps its own currency and is reported as unknown by the rate.
   */
  private async settlementCurrencyFor(
    userId: string,
    row: ScheduledTransaction,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<string> {
    const action = row.investmentAction as InvestmentAction | null;
    if (!action) return row.currencyCode;
    const pair = await this.resolveForecastSettlementPair(
      userId,
      row.accountId,
      FUNDING_ACCOUNT_ACTIONS.has(action)
        ? row.investmentFundingAccountId
        : null,
      row.investmentSecurityId,
      pairCache,
    );
    return pair.to;
  }

  /**
   * The settlement pair for a top-level investment schedule, `null` where there
   * is no single one to name. Reads the same memoized derivation every rate path
   * on the row already went through, so it costs nothing within one read.
   */
  private async settlementPairFor(
    userId: string,
    row: ScheduledTransaction,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<{ from: string; to: string } | null> {
    const action = row.investmentAction as InvestmentAction | null;
    if (!row.isInvestment || !action) return null;
    return this.resolveForecastSettlementPair(
      userId,
      row.accountId,
      FUNDING_ACCOUNT_ACTIONS.has(action)
        ? row.investmentFundingAccountId
        : null,
      row.investmentSecurityId,
      pairCache,
    );
  }

  /**
   * The account a schedule's cash moves through: the settlement account for an
   * investment schedule, the schedule's own account otherwise.
   *
   * Asks `InvestmentTransactionsService`, which owns that decision for the
   * posting path too, so the projection cannot charge a different account than
   * the posting will. A schedule with no action has no settlement pair to speak
   * of, so it keeps its own account (and is reported unknown by the rate).
   */
  private settlementAccountFor(
    userId: string,
    row: ScheduledTransaction,
    cache?: Map<string, Promise<string>>,
  ): Promise<string> {
    const action = row.investmentAction as InvestmentAction | null;
    if (!row.isInvestment || !action) {
      return Promise.resolve(row.accountId);
    }
    const fundingAccountId = FUNDING_ACCOUNT_ACTIONS.has(action)
      ? row.investmentFundingAccountId
      : null;
    const fetch = () =>
      this.investmentTransactionsService.resolveSettlementAccountId(
        userId,
        row.accountId,
        fundingAccountId,
      );
    if (!cache) return fetch();
    const key = `${row.accountId}|${fundingAccountId ?? ""}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetch();
      cache.set(key, pending);
    }
    return pending;
  }

  /**
   * The currency-pair provenance to persist beside a scheduled investment's FX
   * rate (issue #1167). When there is no rate, the pair is null too -- the pair
   * travels with the rate as one tuple. When there is a rate, the pair is
   * derived through the very resolver the posting path uses
   * (`resolveSettlementCurrencyPair`), so the pair a stored rate is later
   * validated against is the pair it would be resolved for.
   */
  async resolveInvestmentRateProvenance(
    userId: string,
    rate: number | null | undefined,
    settlement: {
      accountId: string;
      fundingAccountId: string | null | undefined;
      securityId: string | null | undefined;
    },
  ): Promise<{ from: string | null; to: string | null }> {
    if (rate === null || rate === undefined) {
      return { from: null, to: null };
    }
    const pair =
      await this.investmentTransactionsService.resolveSettlementCurrencyPair(
        userId,
        settlement.accountId,
        settlement.fundingAccountId,
        settlement.securityId,
      );
    return { from: pair.from, to: pair.to };
  }

  /**
   * The settlement currency pair for a tuple, deduped within one read
   * (issue #1167 review). `resolveSettlementCurrencyPair` is 2-3 sequential DB
   * reads (brokerage / linked-cash / security currency lookups), and every
   * forecast resolver derives the SAME pair more than once per row: the
   * stored-current check derives it, and the pair-rate cache key derives it
   * again. Across N rows sharing one `(accountId, fundingAccountId, securityId)`
   * that is O(N) identical lookups even though the currencies are constant within
   * a read. This memo (a Promise per tuple, so concurrent callers join one
   * in-flight derivation) collapses them to one. The cache is passed in -- never
   * an instance field -- so it is scoped to a single read; callers outside a
   * list read omit it and derive directly, unchanged. This memoizes the pair
   * DERIVATION only; the pair-rate FETCH stays deduped by `pairRateCache`, and
   * `InvestmentTransactionsService` remains the sole owner of FX precedence.
   */
  private resolveForecastSettlementPair(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
    cache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<{ from: string; to: string }> {
    const fetch = () =>
      this.investmentTransactionsService.resolveSettlementCurrencyPair(
        userId,
        accountId,
        fundingAccountId,
        securityId,
      );
    if (!cache) return fetch();
    const key = `${accountId}|${fundingAccountId ?? ""}|${securityId ?? ""}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetch();
      cache.set(key, pending);
    }
    return pending;
  }

  /**
   * Whether a stored FX rate may be reused for the current settlement pair
   * (issue #1167). A rate is reused only when its recorded pair still matches
   * the current settlement pair; a rate whose recorded pair no longer matches --
   * or that carries no recorded pair at all -- is not proven to belong to the
   * current pair, so this returns false and the caller forwards no rate, letting
   * the posting resolver re-resolve (and fail loudly if no current rate exists)
   * rather than posting a rate for an unknown pair.
   *
   * A missing pair is "unknown", not "current": every rate the app writes after
   * #1167 carries its pair, so the only rows without one predate the migration,
   * and an unprovable scalar must never be applied to a pair it may not describe.
   */
  async storedInvestmentRateIsCurrent(
    userId: string,
    storedFrom: string | null | undefined,
    storedTo: string | null | undefined,
    settlement: {
      accountId: string;
      fundingAccountId: string | null | undefined;
      securityId: string | null | undefined;
    },
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<boolean> {
    if (!storedFrom || !storedTo) {
      // No recorded pair: unknown, not current -- re-resolve rather than trust.
      return false;
    }
    const pair = await this.resolveForecastSettlementPair(
      userId,
      settlement.accountId,
      settlement.fundingAccountId,
      settlement.securityId,
      pairCache,
    );
    // Same-currency settlement resolves to 1 by definition (issue #1167), so a
    // stored non-1 scalar recorded against an X->X pair is never "the current
    // rate" even when its from/to still equal the pair -- e.g. a 1.50 EUR/CAD
    // rate stamped CAD/CAD after the security's currency changed to CAD, or an
    // explicit re-entry on a since-same-currency pair. Refusing reuse here routes
    // every effective-rate path (parent forecast, split/override, post) through
    // `resolveCashExchangeRateOrNull`, which returns 1 for same-currency, rather
    // than reusing the scalar directly. A stored rate that genuinely is 1 gets
    // the identical result from the resolver, so nothing is lost.
    if (pair.from === pair.to) {
      return false;
    }
    return pair.from === storedFrom && pair.to === storedTo;
  }

  /**
   * The effective FX rate *and* recomputed cash amount for an embedded/override
   * investment split at posting (issue #1167). A split settles through the
   * parent's INVESTMENT_CASH account (no separate funding account), and its cash
   * `amount` is `cashImpact(security currency) x rate` -- so a stale rate makes
   * the stored amount inconsistent with a re-resolved rate, which
   * `createEmbeddedForSplit` would reject (`embeddedSplitAmountMismatch`).
   *
   * The effective rate is the stored one when its recorded pair still matches the
   * current settlement pair, otherwise a freshly resolved rate for the current
   * pair (through the same path posting uses). The cash amount is recomputed from
   * that effective rate so the two always agree. `null` when no current rate can
   * be determined for a genuine cross-currency pair -- the caller decides whether
   * that is a withheld projection or a refused posting.
   */
  async resolveEffectiveSplitCashOrNull(
    userId: string,
    accountId: string,
    securityId: string | null | undefined,
    action: InvestmentAction,
    quantity: number,
    price: number,
    commission: number,
    storedRate: number | null | undefined,
    storedFrom: string | null | undefined,
    storedTo: string | null | undefined,
    asOf: string | Date,
    cache?: Map<string, Promise<number | null>>,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<{ rate: number; amount: number } | null> {
    let effectiveRate: number | null = null;
    if (storedRate !== null && storedRate !== undefined) {
      const isCurrent = await this.storedInvestmentRateIsCurrent(
        userId,
        storedFrom,
        storedTo,
        { accountId, fundingAccountId: null, securityId: securityId ?? null },
        pairCache,
      );
      if (isCurrent) effectiveRate = Number(storedRate);
    }
    if (effectiveRate === null) {
      effectiveRate = await this.resolveForecastPairRate(
        userId,
        accountId,
        null,
        securityId ?? null,
        asOf,
        cache,
        pairCache,
      );
    }
    if (effectiveRate === null) {
      return null;
    }
    return {
      rate: effectiveRate,
      amount: investmentSplitCashAmount(
        action,
        quantity,
        price,
        commission,
        effectiveRate,
      ),
    };
  }

  /**
   * {@link resolveEffectiveSplitCashOrNull} for the posting path, where an
   * unresolvable cross-currency pair is a refusal rather than a withheld
   * projection: posting refuses instead of committing a wrong amount, the same as
   * the non-split investment path.
   */
  async resolveEffectiveSplitCash(
    userId: string,
    accountId: string,
    securityId: string | null | undefined,
    action: InvestmentAction,
    quantity: number,
    price: number,
    commission: number,
    storedRate: number | null | undefined,
    storedFrom: string | null | undefined,
    storedTo: string | null | undefined,
    asOf: string | Date,
    cache?: Map<string, Promise<number | null>>,
  ): Promise<{ rate: number; amount: number }> {
    const eff = await this.resolveEffectiveSplitCashOrNull(
      userId,
      accountId,
      securityId,
      action,
      quantity,
      price,
      commission,
      storedRate,
      storedFrom,
      storedTo,
      asOf,
      cache,
    );
    if (eff === null) {
      const pair =
        await this.investmentTransactionsService.resolveSettlementCurrencyPair(
          userId,
          accountId,
          null,
          securityId ?? null,
        );
      throw new BadRequestException(
        tr(
          "errors.securities.exchangeRateUnavailable",
          `Could not determine an exchange rate for ${pair.from} -> ${pair.to} on the transaction date. Supply an explicit exchangeRate so the cash posting is correct.`,
          { from: pair.from, to: pair.to },
        ),
      );
    }
    return eff;
  }

  /**
   * The effective FX rate for an investment settlement (issue #1167 Round 6 F1):
   * the stored rate when its recorded pair still matches the current settlement
   * pair (posting reuses it), otherwise a freshly resolved one; `null` for an
   * unresolvable cross-currency pair, `1` for same-currency. The single
   * definition of "the rate posting will use", shared by the parent forecast rate
   * and the top-level investment override amount.
   *
   * This must equal what `postInvestment` will use, so the projection agrees with
   * the posting it predicts -- NOT unconditionally the current market rate: a
   * valid persisted rate whose recorded pair still matches is *reused* by
   * posting, so a schedule pinned at 1.50 must not project 1.35 and post 1.50.
   *
   * `asOf` is today: the occurrences are future-dated and `getRateForDate` clamps
   * a future date to today. Passing a date (rather than omitting it) is
   * deliberate -- it takes the same provider-capable rate path posting uses, so
   * the projection does not say "unavailable" for a pair posting could resolve.
   */
  private async resolveEffectiveInvestmentRate(
    userId: string,
    settlement: {
      accountId: string;
      fundingAccountId: string | null | undefined;
      securityId: string | null | undefined;
    },
    stored: {
      rate: number | null;
      from: string | null | undefined;
      to: string | null | undefined;
    },
    asOf: Date,
    // Per-read negative cache for the pair-rate fetch (issue #1167 review
    // R14-F1); omitted outside a list read, where the fetch runs directly.
    cache?: Map<string, Promise<number | null>>,
    // Per-read memo for the settlement-pair DERIVATION (issue #1167 review),
    // shared by the stored-current check and the pair-rate cache key below.
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<number | null> {
    if (
      stored.rate !== null &&
      (await this.storedInvestmentRateIsCurrent(
        userId,
        stored.from,
        stored.to,
        settlement,
        pairCache,
      ))
    ) {
      return stored.rate;
    }
    return this.resolveForecastPairRate(
      userId,
      settlement.accountId,
      settlement.fundingAccountId,
      settlement.securityId,
      asOf,
      cache,
      pairCache,
    );
  }

  /**
   * The settlement-pair FX rate a forecast resolver needs, deduped within one
   * read (issue #1167 review R14-F1). Every forecast path -- parent rate,
   * split-amount and override-amount -- resolves an unchanged pair through the
   * same `resolveCashExchangeRateOrNull(..., undefined, asOf)`, and a pair that
   * does not resolve persists nothing, so without a shared negative cache each
   * of N schedules on the same unfetchable pair re-hits the external FX provider
   * on every read. The cache is passed in (never an instance field) so it
   * is scoped to one call; callers outside a list read omit it and fetch
   * directly, unchanged.
   */
  private async resolveForecastPairRate(
    userId: string,
    accountId: string,
    fundingAccountId: string | null | undefined,
    securityId: string | null | undefined,
    asOf: string | Date,
    cache?: Map<string, Promise<number | null>>,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<number | null> {
    const fetch = () =>
      this.investmentTransactionsService.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        fundingAccountId,
        securityId,
        undefined,
        asOf,
      );
    if (!cache) return fetch();
    // Key the negative cache by the DIRECTIONAL CURRENCY PAIR, not the entity
    // tuple (issue #1167 review, R14 follow-up): twenty different securities that
    // all settle USD->CAD ask the provider one and the same question, and a
    // failed lookup persists nothing -- so an (account, security) key would still
    // hit the provider once per security. Derive the pair (a cheap account/
    // security currency read, not a provider call) and key by `from->to`; the
    // rate for a cross-currency pair is a property of the pair, and same-currency
    // resolves to 1 inside `fetch()` regardless of which security asked. `asOf`
    // is constant across one read, so the pair is the whole key.
    const pair = await this.resolveForecastSettlementPair(
      userId,
      accountId,
      fundingAccountId,
      securityId,
      pairCache,
    );
    const key = `${pair.from}->${pair.to}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetch();
      cache.set(key, pending);
    }
    return pending;
  }

  private async resolveInvestmentForecastRate(
    userId: string,
    transaction: ScheduledTransaction,
    asOf: Date,
    cache?: Map<string, Promise<number | null>>,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<number | null> {
    if (!transaction.isInvestment || !transaction.investmentAction) {
      return null;
    }
    const action = transaction.investmentAction as InvestmentAction;
    return this.resolveEffectiveInvestmentRate(
      userId,
      {
        accountId: transaction.accountId,
        fundingAccountId: FUNDING_ACCOUNT_ACTIONS.has(action)
          ? transaction.investmentFundingAccountId
          : null,
        securityId: transaction.investmentSecurityId,
      },
      {
        rate:
          transaction.investmentExchangeRate !== null &&
          transaction.investmentExchangeRate !== undefined
            ? Number(transaction.investmentExchangeRate)
            : null,
        from: transaction.investmentExchangeRateFromCurrency,
        to: transaction.investmentExchangeRateToCurrency,
      },
      asOf,
      cache,
      pairCache,
    );
  }

  /**
   * The effective total amount a split-investment schedule would post *today*
   * (issue #1167 F-rev3.2), for the projection to use instead of the stored
   * parent amount -- which is stale once a referenced security's or settlement
   * account's currency changes. It re-sums the base scheduled splits with each
   * investment split's *effective* cash amount (stored rate when its recorded
   * pair still matches, otherwise a freshly resolved one, through the same path
   * posting uses), leaving non-investment splits at their stored amount.
   *
   * Returns `null` for a schedule that is not a split-investment one (so the
   * caller uses `amount` unchanged), and also `null` when any investment
   * split's current rate cannot be resolved -- the projection then withholds the
   * whole occurrence, matching what posting would do (refuse) rather than
   * projecting a stale figure. This covers the base schedule only; a
   * per-occurrence override carries its own stored amount, as every other
   * override does.
   */
  private async resolveInvestmentForecastSplitAmount(
    userId: string,
    transaction: ScheduledTransaction,
    asOf: Date,
    cache?: Map<string, Promise<number | null>>,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<number | null> {
    if (!hasEmbeddedInvestmentSplits(transaction)) {
      return null;
    }
    const amounts: number[] = [];
    for (const split of transaction.splits!) {
      if (split.kind === SplitKind.INVESTMENT && split.investmentAction) {
        const quantity =
          split.investmentQuantity !== null &&
          split.investmentQuantity !== undefined
            ? Number(split.investmentQuantity)
            : 0;
        const price =
          split.investmentPrice !== null && split.investmentPrice !== undefined
            ? Number(split.investmentPrice)
            : 0;
        const commission =
          split.investmentCommission !== null &&
          split.investmentCommission !== undefined
            ? Number(split.investmentCommission)
            : 0;
        const eff = await this.resolveEffectiveSplitCashOrNull(
          userId,
          transaction.accountId,
          split.investmentSecurityId,
          split.investmentAction,
          quantity,
          price,
          commission,
          split.investmentExchangeRate,
          split.investmentExchangeRateFromCurrency,
          split.investmentExchangeRateToCurrency,
          asOf,
          cache,
          pairCache,
        );
        if (eff === null) {
          // Current rate unknown -> the whole projection is unknown.
          return null;
        }
        amounts.push(eff.amount);
      } else {
        amounts.push(Number(split.amount));
      }
    }
    // Investment-carrying lines settle through brokerage cash: fiat.
    return sumMoney(amounts, FIAT_MONEY_DECIMALS);
  }

  /**
   * The effective cash total a *per-occurrence override* would post today (issue
   * #1167, F5-2 + Round 6 F3). An override's stored `amount` is a snapshot at the
   * rate current when it was created, and a top-level investment override stores
   * quantity/price/total rather than an amount at all -- so the projection must
   * recompute what posting will do, not read the stale scalar.
   *
   * Three shapes:
   *   - **top-level investment override** (parent schedule is an investment): the
   *     signed cash impact of the override-or-base quantity/price/total at the
   *     effective rate. Computed for *every* override of an investment schedule,
   *     even a date-only one, so `null` stays reserved for a genuinely unknown FX
   *     rate rather than "no investment override".
   *   - **split-investment override**: its base splits re-summed at current FX.
   *   - **anything else**: `undefined`, so the caller keeps using the override's
   *     own stored `amount`.
   * `null` means investment-related but the current rate is unknown -- the
   * occurrence is withheld.
   */
  private async resolveOverrideInvestmentForecastAmount(
    userId: string,
    scheduled: ScheduledTransaction,
    override: ScheduledTransactionOverride,
    asOf: Date,
    cache?: Map<string, Promise<number | null>>,
    pairCache?: Map<string, Promise<{ from: string; to: string }>>,
  ): Promise<number | null | undefined> {
    // Top-level investment override: same precedence as postInvestment
    // (override value -> base fallback) at the effective (stored-or-resolved) rate.
    if (scheduled.isInvestment && scheduled.investmentAction) {
      const action = scheduled.investmentAction as InvestmentAction;
      const rate = await this.resolveEffectiveInvestmentRate(
        userId,
        {
          accountId: scheduled.accountId,
          fundingAccountId: FUNDING_ACCOUNT_ACTIONS.has(action)
            ? scheduled.investmentFundingAccountId
            : null,
          securityId: scheduled.investmentSecurityId,
        },
        {
          rate:
            scheduled.investmentExchangeRate !== null &&
            scheduled.investmentExchangeRate !== undefined
              ? Number(scheduled.investmentExchangeRate)
              : null,
          from: scheduled.investmentExchangeRateFromCurrency,
          to: scheduled.investmentExchangeRateToCurrency,
        },
        asOf,
        cache,
        pairCache,
      );
      if (rate === null) {
        return null;
      }
      const quantity = Number(
        override.investmentQuantity ?? scheduled.investmentQuantity ?? 0,
      );
      const price = Number(
        override.investmentPrice ?? scheduled.investmentPrice ?? 0,
      );
      const commission = Number(scheduled.investmentCommission ?? 0);
      const total =
        override.investmentTotalAmount ?? scheduled.investmentTotalAmount;
      // Amount-only income actions carry their cash directly (positive); every
      // other action derives it from quantity/price/commission, signed by side.
      const cashSecurity = AMOUNT_ONLY_ACTIONS.has(action)
        ? Number(total ?? 0)
        : computeInvestmentCashImpact(action, quantity, price, commission);
      return roundMoney(cashSecurity * rate, FIAT_MONEY_DECIMALS);
    }

    // Split-investment override: re-sum its base splits at current FX.
    if (!override.isSplit || !override.splits?.length) {
      return undefined;
    }
    const hasInvestmentSplit = override.splits.some((s) => s.investment);
    if (!hasInvestmentSplit) {
      return undefined;
    }
    const amounts: number[] = [];
    for (const split of override.splits) {
      const inv = split.investment;
      if (inv) {
        const eff = await this.resolveEffectiveSplitCashOrNull(
          userId,
          scheduled.accountId,
          inv.securityId,
          inv.action as InvestmentAction,
          Number(inv.quantity ?? 0),
          Number(inv.price ?? 0),
          Number(inv.commission ?? 0),
          inv.exchangeRate,
          inv.exchangeRateFromCurrency,
          inv.exchangeRateToCurrency,
          asOf,
          cache,
          pairCache,
        );
        if (eff === null) {
          return null;
        }
        amounts.push(eff.amount);
      } else {
        amounts.push(Number(split.amount));
      }
    }
    // Investment-carrying lines settle through brokerage cash: fiat.
    return sumMoney(amounts, FIAT_MONEY_DECIMALS);
  }
}

/**
 * A split parent carrying at least one embedded investment split line. Its cash
 * impact is FX-sensitive the same way a parent investment schedule is (issue
 * #1167), but it has no single settlement rate -- each investment line settles
 * its own security's currency -- so the server sends one recomputed effective
 * total rather than a rate.
 */
/**
 * The sign each line of a split contributes, without needing any FX rate.
 *
 * A fixed line contributes the sign of its own amount. An investment line
 * contributes the sign of its cash impact, which `computeInvestmentCashImpact`
 * derives from the ACTION (a BUY removes cash, a SELL brings it in) -- the rate
 * that is missing only scales the magnitude, and a rate is positive, so it cannot
 * move the sign. Zero lines contribute nothing either way.
 */
function splitLineSigns(
  lines: ReadonlyArray<{
    amount?: number | string | null;
    kind?: SplitKind;
    investmentAction?: InvestmentAction | null;
    investmentQuantity?: number | string | null;
    investmentPrice?: number | string | null;
    investmentCommission?: number | string | null;
  }>,
): number[] {
  return lines
    .map((line) => {
      if (line.kind === SplitKind.INVESTMENT && line.investmentAction) {
        return Math.sign(
          computeInvestmentCashImpact(
            line.investmentAction,
            Number(line.investmentQuantity ?? 0),
            Number(line.investmentPrice ?? 0),
            Number(line.investmentCommission ?? 0),
          ),
        );
      }
      return Math.sign(Number(line.amount ?? 0));
    })
    .filter((sign) => sign !== 0);
}

/**
 * An override's split lines in the shape `splitLineSigns` reads.
 *
 * An override stores its splits as JSON with the investment payload nested under
 * `investment`, where a base schedule's splits carry the same fields flat -- the
 * two shapes are why this adapter exists rather than one union type.
 */
function overrideSplitLines(override: ScheduledTransactionOverride): Array<{
  amount?: number | string | null;
  kind?: SplitKind;
  investmentAction?: InvestmentAction | null;
  investmentQuantity?: number | string | null;
  investmentPrice?: number | string | null;
  investmentCommission?: number | string | null;
}> {
  return (override.splits ?? []).map((split) => {
    const inv = split.investment;
    return inv
      ? {
          kind: SplitKind.INVESTMENT,
          investmentAction: inv.action as InvestmentAction,
          investmentQuantity: inv.quantity,
          investmentPrice: inv.price,
          investmentCommission: inv.commission,
        }
      : { amount: split.amount };
  });
}

/**
 * Whether an unpriceable total's sign is provable from the signs of its parts.
 *
 * True when every part points the same way (or there are no parts at all, which
 * is the single-scalar case). False for a mixed-sign aggregate, where the missing
 * rate decides which side of zero the total lands on.
 */
function signIsProvable(signs: readonly number[]): boolean {
  return signs.length === 0 || signs.every((sign) => sign === signs[0]);
}

export function hasEmbeddedInvestmentSplits(
  transaction: Pick<ScheduledTransaction, "isSplit" | "splits">,
): boolean {
  return (
    transaction.isSplit === true &&
    (transaction.splits?.some(
      (s) => s.kind === SplitKind.INVESTMENT && !!s.investmentAction,
    ) ??
      false)
  );
}
