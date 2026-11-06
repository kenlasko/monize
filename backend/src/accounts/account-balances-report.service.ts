import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { FxAggregate } from "../common/fx-aggregate";
import { convertWithRateLookup } from "../common/currency-conversion.util";
import {
  FIAT_MONEY_DECIMALS,
  moneyDecimalsFor,
  roundMoney,
} from "../common/round.util";
import {
  applyActionToQuantity,
  INVESTMENT_REPLAY_ORDER_SQL,
} from "../securities/investment-replay.util";
import {
  BOUNDARY_LAG_DAYS,
  closeAt,
  withLeadDays,
  type PricePoint,
} from "../common/time-series/price-boundary.util";
import {
  nearestClosesFor,
  nearestRatesFor,
} from "../common/time-series/nearest-observation";
import { todayYMD } from "../common/date-utils";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SecurityPriceService } from "../securities/security-price.service";
import {
  BondValuationService,
  ownLotsGrossValue,
  SecurityValueByAccount,
} from "../bonds/bond-valuation.service";
import { preferredCurrency } from "../common/default-currency.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";

/**
 * One account's worth at the end of a single day.
 *
 * `docs/specs/account-balances-as-of.md` is canonical for what each field means
 * and when it is allowed to be `null`; the short version is that `balance` is a
 * ledger sum the database always knows, and `marketValue` is a *total* -- so it
 * is `null` unless every position in the account was both priced and converted.
 */
export interface AccountBalanceAsOf {
  accountId: string;
  currencyCode: string;
  balance: number;
  marketValue: number | null;
  knownMarketValueSubtotal: number;
  unpricedHoldingsCount: number;
  missingRatePairs: string[];
  pricesComplete: boolean;
  fxComplete: boolean;
  valuationComplete: boolean;
  /**
   * Held positions valued at the closest close the database holds, because
   * nothing was observed inside the accepted window for `asOfDate` and the
   * provider could not fill it (spec section 4.2).
   *
   * The figure is a real observation, so it is *known* -- which is why it
   * counts towards a complete valuation rather than nulling it -- but it was
   * struck on another day, and a consumer must say so. Zero means every price
   * behind this row stood for the date itself.
   */
  approximatedPriceCount: number;
  /**
   * `"USD->CAD"` for each pair this row converted at the closest rate outside
   * the window, on the same terms as `approximatedPriceCount` (spec section
   * 7.2).
   */
  approximatedRatePairs: string[];
  /**
   * Whether the account existed at `asOfDate`.
   *
   * An account's inception is the first date it has anything to report: an
   * asset's `date_acquired` when it has one, otherwise its earliest non-VOID
   * ledger or investment movement. Before that date the account is not a thing
   * with a balance -- an asset bought in 2024 was not worth its purchase price
   * in 2019, and an opening balance is the sum the account *started* at, not a
   * figure it carried backwards forever.
   *
   * `false` therefore means "did not exist yet", and `balance` is 0 rather than
   * the opening balance the ledger sum would otherwise carry. An account with
   * no acquisition date and no transactions at all has nothing dating its
   * inception, so it is `true` at every date: nothing here guesses one from
   * `created_at`, which records when the row was typed in rather than when the
   * account came to exist.
   */
  existsAsOf: boolean;
}

export interface AccountBalancesAsOfResponse {
  /** Echoes the date the figures were measured at, so the payload carries its own request key. */
  asOfDate: string;
  /** The user's reporting currency, which every total is presented in. */
  displayCurrency: string;
  /**
   * Multiplier from each account currency present to `displayCurrency`, as the
   * rate stood on `asOfDate`.
   *
   * A currency **absent** from this map has no accepted rate for that date, and
   * a consumer must treat its accounts as unconvertible rather than reaching
   * for a live rate or for 1 -- which is the whole point of shipping the rates
   * beside the figures they belong to. `displayCurrency` itself is present at
   * 1, because same-currency is 1:1 by definition and has to stay
   * distinguishable from the missing case.
   */
  displayRates: Record<string, number>;
  /**
   * Currency -> the date the rate presenting it was actually struck on, for
   * every entry in `displayRates` that came from the closest observation
   * outside the accepted window rather than from `asOfDate` itself.
   *
   * A currency absent from here converted at a rate that stood on the date. A
   * currency absent from `displayRates` has no rate at all -- the two absences
   * mean opposite things, which is why the approximation is named rather than
   * folded into the rate map it qualifies.
   */
  approximatedDisplayRates: Record<string, string>;
  accounts: AccountBalanceAsOf[];
}

/**
 * The rates the report converts with, and which of them are approximations.
 *
 * `approximated` is keyed exactly as `rates` is (`"USD->CAD"`, in the direction
 * the rate is stored) and holds the date each such observation was struck on.
 */
interface ResolvedRates {
  rates: Map<string, number>;
  approximated: Map<string, string>;
}

/** The closes the report values with, and which of them are approximations. */
interface ResolvedPrices {
  prices: Map<string, number>;
  approximated: Map<string, string>;
}

/** A share position is treated as closed below this, matching HoldingsService. */
const QUANTITY_EPSILON = 0.00000001;

/** accountId -> securityId -> share count at the report's date. */
type AccountPositions = Map<string, Map<string, number>>;

/** The market-value half of one account's row -- everything but the ledger sum. */
type AccountValuation = Omit<
  AccountBalanceAsOf,
  "accountId" | "currencyCode" | "balance" | "existsAsOf"
>;

/** The securities still held (non-zero) anywhere in a replay. */
function heldSecuritiesIn(positions: AccountPositions): string[] {
  return [
    ...new Set(
      [...positions.values()].flatMap((bySecurity) =>
        [...bySecurity.entries()]
          .filter(([, qty]) => Math.abs(qty) > QUANTITY_EPSILON)
          .map(([securityId]) => securityId),
      ),
    ),
  ];
}

/**
 * Every currency pair this report has to convert, deduplicated.
 *
 * Two jobs need rates and they are not the same pairs: presenting each
 * account's figures in the user's reporting currency, and pricing a foreign
 * security into the currency of the account that holds it. A USD holding in a
 * CAD brokerage read in CAD needs `USD->CAD` for both reasons; a USD holding in
 * a USD brokerage read in CAD needs only the second. Collecting both here is
 * what lets one fetch settle the whole report -- and what keeps the report from
 * asking the provider for a pair it was never going to convert.
 *
 * A position with no quantity left is not a currency the report needs, and a
 * security whose currency is unknown is valued in its account's currency (the
 * valuation's own fallback), so neither contributes a pair.
 */
function requiredRatePairs(input: {
  accountCurrencies: string[];
  displayCurrency: string;
  holdingsAccounts: Array<{ id: string; currencyCode: string }>;
  positions: AccountPositions;
  securityCurrencies: Map<string, string>;
}): Array<{ from: string; to: string }> {
  const pairs = new Map<string, { from: string; to: string }>();
  const want = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    pairs.set(`${from}->${to}`, { from, to });
  };

  for (const currency of input.accountCurrencies) {
    want(currency, input.displayCurrency);
  }
  for (const account of input.holdingsAccounts) {
    for (const [securityId, quantity] of input.positions.get(account.id) ??
      []) {
      if (Math.abs(quantity) <= QUANTITY_EPSILON) continue;
      const securityCurrency = input.securityCurrencies.get(securityId);
      if (securityCurrency) want(securityCurrency, account.currencyCode);
    }
  }

  return [...pairs.values()];
}

/**
 * The date the *market* is read at, for a report asked about `asOfDate`.
 *
 * The ledger runs ahead -- a transaction can be dated next year -- but prices
 * and rates cannot, so a future `asOfDate` is clamped to today, which is the
 * same thing `ExchangeRateService.getRateForDate` does and for the same reason:
 * today's figure is the best available estimate of a day that has not happened.
 *
 * Without the clamp the staleness bound refuses its own inputs. `closeAt` asks
 * how old an observation is *relative to the date being priced*, so a report
 * dated a year out would find today's close 365 days stale and call every
 * position unpriced -- and the bounded query would not even return it.
 */
function marketDateFor(asOfDate: string): string {
  const today = todayYMD();
  return asOfDate > today ? today : asOfDate;
}

/**
 * The date the rate used for `from -> to` was struck on, when that rate is an
 * approximation -- `null` when the conversion is same-currency, unresolvable,
 * or made at a rate that stood on the report's own date.
 *
 * It mirrors `convertWithRateLookup`'s direct-then-inverse preference rather
 * than testing both keys, because the pair the conversion *used* is the only
 * one whose vintage the figure inherits: a stored `USD->CAD` inside the window
 * is not made approximate by an old `CAD->USD` sitting beside it.
 */
function approximateRateDate(
  rates: ResolvedRates,
  from: string,
  to: string,
): string | null {
  if (!from || from === to) return null;
  const direct = rates.rates.get(`${from}->${to}`);
  if (direct != null && direct > 0) {
    return rates.approximated.get(`${from}->${to}`) ?? null;
  }
  const inverse = rates.rates.get(`${to}->${from}`);
  if (inverse != null && inverse > 0) {
    return rates.approximated.get(`${to}->${from}`) ?? null;
  }
  return null;
}

/**
 * Point-in-time balances for the Account Balances report (issue #1198).
 *
 * Kept apart from `AccountsService` because it answers a different question:
 * that service maintains `current_balance`, a running figure the ledger writes
 * keep up to date, while this one measures every account at a date the caller
 * chose -- which may be years back or years ahead.
 */
@Injectable()
export class AccountBalancesReportService {
  private readonly logger = new Logger(AccountBalancesReportService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates: ExchangeRateService,
    @Inject(forwardRef(() => SecurityPriceService))
    private readonly securityPrices: SecurityPriceService,
    @Inject(forwardRef(() => BondValuationService))
    private readonly bondValuation: BondValuationService,
  ) {}

  private scopedQuery<T = any>(sql: string, params?: any[]): Promise<T> {
    return withScopedDb(this.dataSource, (m) => m.query(sql, params));
  }

  /**
   * Every account the caller can see, valued at the end of `asOfDate`.
   *
   * `jointAccountIds` are accounts another owner shared with the caller; the
   * controller has already authorized them, and the predicate widens to those
   * exact ids and nothing else -- the same shape `getDailyBalances` uses.
   *
   * `restrictToAccountIds` narrows the answer to exactly those accounts, for a
   * delegate whose grant names a subset of the owner's. It is a restriction on
   * the *query*, not a filter over its result: reading the owner's other
   * balances and dropping them afterwards answers correctly while still having
   * read them.
   */
  async getBalancesAsOf(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[] = [],
    restrictToAccountIds?: string[],
  ): Promise<AccountBalancesAsOfResponse> {
    // An answer with no accounts in it still has a reporting currency: the
    // client draws its (zero) totals and its empty state in one, and a response
    // that omitted it would leave that currency to be guessed.
    const displayCurrency = await this.resolveDisplayCurrency(userId);
    const empty = {
      asOfDate,
      displayCurrency,
      displayRates: { [displayCurrency]: 1 },
      approximatedDisplayRates: {},
      accounts: [],
    };

    // An empty restriction is "no accounts", not "no restriction": a delegate
    // granted nothing must not fall through to the owner's whole list.
    if (restrictToAccountIds && restrictToAccountIds.length === 0) return empty;
    const restriction = restrictToAccountIds ?? null;

    const accounts: Array<{
      id: string;
      currency_code: string;
      account_type: string;
      account_sub_type: string | null;
      date_acquired: string | null;
    }> = await this.scopedQuery(
      `SELECT id, currency_code, account_type, account_sub_type,
              date_acquired::text AS date_acquired
         FROM accounts
        WHERE (user_id = $1 OR id = ANY($2::UUID[]))
          AND ($3::UUID[] IS NULL OR id = ANY($3::UUID[]))`,
      [userId, jointAccountIds, restriction],
    );

    if (accounts.length === 0) return empty;

    const [ledgerBalances, firstActivity] = await Promise.all([
      this.ledgerBalances(userId, asOfDate, jointAccountIds, restriction),
      this.firstActivityDates(userId, jointAccountIds, restriction),
    ]);

    const marketDate = marketDateFor(asOfDate);

    // Only these hold securities. The cash sleeve of a linked pair is an
    // ordinary ledger account and is excluded here, exactly as it is everywhere
    // else -- counting it twice is the double-count the pairing exists to avoid.
    const holdingsAccounts = accounts
      .filter(
        (a) =>
          a.account_type === "INVESTMENT" &&
          (a.account_sub_type === "INVESTMENT_BROKERAGE" ||
            !a.account_sub_type),
      )
      .map((a) => ({ id: a.id, currencyCode: a.currency_code }));

    // The replay runs before the rates are read because it is what says which
    // pairs the report needs: a security's currency only matters once something
    // holds it, and asking the provider for a pair nobody is waiting on is a
    // round trip spent on nothing. Prices come alongside -- a different source
    // answering a different question, and neither depends on a rate.
    const positions = await this.positionsAsOf(
      holdingsAccounts.map((a) => a.id),
      asOfDate,
    );
    const heldSecurityIds = heldSecuritiesIn(positions);
    const [storedPrices, securityCurrencies] = await Promise.all([
      this.closingPricesAsOf(heldSecurityIds, marketDate),
      this.securityCurrencies(heldSecurityIds),
    ]);

    // Two independent gaps, filled concurrently because neither answer feeds
    // the other: a rate the database never fetched, and a close it never
    // fetched. Both are absences rather than unknowables, and both make this
    // report's totals null when left alone.
    //
    // One rate read serves both of the rate's jobs -- pricing a foreign holding
    // into its own account's currency, and presenting every account in the
    // user's. Reading them twice would be two chances for the two halves of one
    // report to be converted at different vintages.
    const [rates, prices] = await Promise.all([
      this.ratesForReport(
        requiredRatePairs({
          accountCurrencies: accounts.map((a) => a.currency_code),
          displayCurrency,
          holdingsAccounts,
          positions,
          securityCurrencies,
        }),
        marketDate,
      ),
      this.pricesForReport(heldSecurityIds, storedPrices, marketDate),
    ]);

    const bondValues = await this.bondValuesAsOf(
      userId,
      heldSecurityIds,
      asOfDate,
    );
    const marketValues = this.valuePositions(
      holdingsAccounts,
      positions,
      prices,
      securityCurrencies,
      rates,
      asOfDate,
      bondValues,
    );

    const display = this.displayRates(
      accounts.map((a) => a.currency_code),
      displayCurrency,
      rates,
      asOfDate,
    );

    return {
      asOfDate,
      displayCurrency,
      displayRates: display.rates,
      approximatedDisplayRates: display.approximated,
      accounts: accounts.map((a) => {
        const existsAsOf = this.existedOn(
          a,
          firstActivity.get(a.id) ?? null,
          asOfDate,
        );
        // Before its inception the account held nothing, so the opening balance
        // the ledger sum would otherwise carry does not travel back with it.
        const balance = existsAsOf ? (ledgerBalances.get(a.id) ?? 0) : 0;
        const valuation = marketValues.get(a.id);
        // A row that holds no securities has no market value to report -- that
        // is "does not apply", which is why the completeness flag stays true
        // rather than following the null.
        if (!valuation) {
          return {
            accountId: a.id,
            currencyCode: a.currency_code,
            balance,
            marketValue: null,
            knownMarketValueSubtotal: 0,
            unpricedHoldingsCount: 0,
            missingRatePairs: [],
            pricesComplete: true,
            fxComplete: true,
            valuationComplete: true,
            approximatedPriceCount: 0,
            approximatedRatePairs: [],
            existsAsOf,
          };
        }
        return {
          accountId: a.id,
          currencyCode: a.currency_code,
          balance,
          ...valuation,
          existsAsOf,
        };
      }),
    };
  }

  /**
   * Opening balance plus every non-void, non-child transaction dated on or
   * before `asOfDate` -- the same expression `recalculateCurrentBalance` uses,
   * with the caller's date in place of today.
   */
  private async ledgerBalances(
    userId: string,
    asOfDate: string,
    jointAccountIds: string[],
    restriction: string[] | null,
  ): Promise<Map<string, number>> {
    // Each balance is in its account's own currency, before any conversion,
    // so it rounds at that currency's precision; the places ride along in
    // the same statement rather than a read per account.
    const rows: Array<{
      id: string;
      balance: string;
      decimal_places?: number | string | null;
    }> = await this.scopedQuery(
      `SELECT a.id,
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance,
                c.decimal_places
           FROM accounts a
           LEFT JOIN currencies c ON c.code = a.currency_code
           LEFT JOIN transactions t ON t.account_id = a.id
            AND ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date <= $2
          WHERE (a.user_id = $1 OR a.id = ANY($3::UUID[]))
            AND ($4::UUID[] IS NULL OR a.id = ANY($4::UUID[]))
          GROUP BY a.id, a.opening_balance, c.decimal_places`,
      [userId, asOfDate, jointAccountIds, restriction],
    );

    return new Map(
      rows.map((r) => [
        r.id,
        roundMoney(
          Number(r.balance),
          moneyDecimalsFor(
            r.decimal_places === null || r.decimal_places === undefined
              ? null
              : Number(r.decimal_places),
          ),
        ),
      ]),
    );
  }

  /**
   * The earliest date each account has any movement on record, over both
   * ledgers -- ordinary transactions and investment transactions.
   *
   * Deliberately unbounded by `asOfDate`: the question it answers is whether
   * the report's date falls *before* the account's first movement, which a
   * window ending at that date cannot tell from "this account has never had
   * one". `LEAST` ignores NULLs, so it is null only when both ledgers are
   * empty.
   */
  private async firstActivityDates(
    userId: string,
    jointAccountIds: string[],
    restriction: string[] | null,
  ): Promise<Map<string, string>> {
    const rows: Array<{ id: string; first_activity: string | null }> =
      await this.scopedQuery(
        `SELECT a.id,
                LEAST(
                  (SELECT MIN(t.transaction_date)
                     FROM transactions t
                    WHERE t.account_id = a.id
                      AND ${LEDGER_MOVEMENT_PREDICATE}),
                  (SELECT MIN(it.transaction_date)
                     FROM investment_transactions it
                    WHERE it.account_id = a.id
                      AND it.status != 'VOID')
                )::text AS first_activity
           FROM accounts a
          WHERE (a.user_id = $1 OR a.id = ANY($2::UUID[]))
            AND ($3::UUID[] IS NULL OR a.id = ANY($3::UUID[]))`,
        [userId, jointAccountIds, restriction],
      );

    const dates = new Map<string, string>();
    for (const row of rows) {
      if (row.first_activity)
        dates.set(row.id, row.first_activity.slice(0, 10));
    }
    return dates;
  }

  /**
   * Whether the account was a thing with a balance at `asOfDate`.
   *
   * Its inception is `date_acquired` for an asset that carries one -- the date
   * the user says they came to own it, which is the same date net worth zeroes
   * an asset before -- and otherwise its first movement on either ledger. An
   * acquisition date wins over an earlier transaction rather than being
   * minimised with it: the field's whole job is to say when the asset started
   * existing, and the two disagreeing is a correction the user has already made.
   * A *future* acquisition date is honoured as written, because it is the user's
   * own statement about an asset they do not own yet.
   *
   * A first movement in the future is not, and it is capped at today. The row is
   * in `accounts` as this query runs, so the account demonstrably exists now
   * whatever its ledger says about next week -- and without the cap an account
   * funded with an opening balance whose only entry is an upcoming bill
   * disappears from today's own balance sheet.
   *
   * With neither, nothing dates the account's inception and it is reported at
   * every date. `created_at` is not a candidate -- it records when the row was
   * typed in, so an account imported today would vanish from its own history.
   */
  private existedOn(
    account: { account_type: string; date_acquired: string | null },
    firstActivity: string | null,
    asOfDate: string,
  ): boolean {
    if (account.account_type === "ASSET" && account.date_acquired) {
      return asOfDate >= account.date_acquired.slice(0, 10);
    }
    if (firstActivity === null) return true;
    const today = todayYMD();
    return asOfDate >= (firstActivity < today ? firstActivity : today);
  }

  /**
   * Replay each holdings account's investment ledger to `asOfDate` and return
   * what it held at the end of it.
   *
   * Split out from the valuation beside it because the two answer different
   * questions at different times: this one says which securities -- and so
   * which currencies -- the report is about, and the report has to know that
   * before it can tell which exchange rates it is missing.
   */
  private async positionsAsOf(
    accountIds: string[],
    asOfDate: string,
  ): Promise<AccountPositions> {
    if (accountIds.length === 0) return new Map();

    const transactions: Array<{
      account_id: string;
      security_id: string;
      action: string;
      quantity: string | null;
    }> = await this.scopedQuery(
      `SELECT account_id, security_id, action, quantity
         FROM investment_transactions
        WHERE account_id = ANY($1::UUID[])
          AND security_id IS NOT NULL
          AND status != 'VOID'
          AND transaction_date <= $2
        ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
      [accountIds, asOfDate],
    );

    // accountId -> securityId -> quantity, folded through the one reducer every
    // other replay in the codebase uses (a SPLIT's quantity is a ratio).
    const positions: AccountPositions = new Map();
    for (const tx of transactions) {
      let bySecurity = positions.get(tx.account_id);
      if (!bySecurity) {
        bySecurity = new Map<string, number>();
        positions.set(tx.account_id, bySecurity);
      }
      bySecurity.set(
        tx.security_id,
        applyActionToQuantity(
          bySecurity.get(tx.security_id) ?? 0,
          tx.action,
          Number(tx.quantity ?? 0),
        ),
      );
    }
    return positions;
  }

  /**
   * What each account's lots of every bond-linked security held are worth at
   * `asOfDate` (the report's date, whatever it is: the engine values a lot on
   * any day). A linked security's stored close is the blend over every
   * account's lots, so an account holding other series than the blend's average
   * would be shown the average (bond-program-securities.md 2.4). A security
   * whose valuation throws maps to null: unpriced, never the blend. One
   * `valueByAccount` call per linked security. Owner-scoped, so a security of
   * another owner (a joint account's) is unpriced here.
   */
  private async bondValuesAsOf(
    userId: string,
    securityIds: string[],
    asOfDate: string,
  ): Promise<Map<string, SecurityValueByAccount | null>> {
    const values = new Map<string, SecurityValueByAccount | null>();
    if (securityIds.length === 0) return values;
    const linked: Array<{ id: string }> = await this.scopedQuery(
      `SELECT id FROM securities
        WHERE id = ANY($1::UUID[]) AND bond_program_id IS NOT NULL`,
      [securityIds],
    );
    for (const { id } of linked) {
      try {
        values.set(
          id,
          await this.bondValuation.valueByAccount(userId, id, asOfDate),
        );
      } catch (error) {
        this.logger.warn(
          `Bond valuation of security ${id} at ${asOfDate} failed; its positions are unpriced: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        values.set(id, null);
      }
    }
    return values;
  }

  /**
   * Value each account's replayed positions at the prices and rates standing
   * for the report's date.
   *
   * Deliberately synchronous: everything it needs has already been read, which
   * is what lets the caller settle the rate map -- fetching the pairs nobody
   * stored yet -- before a single figure is computed from it.
   */
  private valuePositions(
    holdingsAccounts: Array<{ id: string; currencyCode: string }>,
    positions: AccountPositions,
    prices: ResolvedPrices,
    securityCurrencies: Map<string, string>,
    rates: ResolvedRates,
    asOfDate: string,
    bondValues: ReadonlyMap<string, SecurityValueByAccount | null> = new Map(),
  ): Map<string, AccountValuation> {
    const result = new Map<string, AccountValuation>();
    const lookup = (from: string, to: string) =>
      rates.rates.get(`${from}->${to}`);

    for (const account of holdingsAccounts) {
      const bySecurity = positions.get(account.id);
      const aggregate = new FxAggregate();
      const unpriced = new Set<string>();
      const approximatedPrices = new Set<string>();
      const approximatedPairs = new Set<string>();

      for (const [securityId, quantity] of bySecurity ?? []) {
        if (Math.abs(quantity) <= QUANTITY_EPSILON) continue;
        // A bond-linked position is its own account's lots, or unknown.
        const isLinked = bondValues.has(securityId);
        const own = isLinked
          ? ownLotsGrossValue(bondValues.get(securityId), account.id, quantity)
          : null;
        const price = prices.prices.get(securityId);
        // An unpriced position is unknown, not free. Folding it in at zero is
        // what makes a partial valuation look like a settled one.
        if (isLinked ? own === null || "unpriced" in own : price == null) {
          unpriced.add(securityId);
          continue;
        }
        if (!isLinked && prices.approximated.has(securityId))
          approximatedPrices.add(securityId);
        const securityCurrency =
          securityCurrencies.get(securityId) ?? account.currencyCode;
        const converted = convertWithRateLookup(
          own !== null && "grossValue" in own
            ? Number(own.grossValue)
            : quantity * (price as number),
          securityCurrency,
          account.currencyCode,
          lookup,
        );
        // Only a conversion that actually happened can have been approximated;
        // a pair with no rate at all is a gap the aggregate already names, and
        // reporting it as both missing and approximated would say two
        // contradictory things about one component.
        if (
          converted !== null &&
          approximateRateDate(rates, securityCurrency, account.currencyCode) !==
            null
        ) {
          approximatedPairs.add(`${securityCurrency}->${account.currencyCode}`);
        }
        aggregate.add(converted, securityCurrency, account.currencyCode);
      }

      const missingRatePairs = aggregate.missingPairs;
      if (missingRatePairs.length > 0) {
        this.logger.warn(
          `Account ${account.id} valuation at ${asOfDate} omits positions with no exchange rate (${missingRatePairs.join(", ")})`,
        );
      }
      const complete = aggregate.isComplete && unpriced.size === 0;
      // Investment positions are fiat (INV-CRYPTO-001).
      const knownSubtotal = roundMoney(
        aggregate.knownSubtotal,
        FIAT_MONEY_DECIMALS,
      );
      if (approximatedPrices.size > 0 || approximatedPairs.size > 0) {
        this.logger.log(
          `Account ${account.id} valuation at ${asOfDate} uses the closest available data: ` +
            `${approximatedPrices.size} approximated price(s)` +
            (approximatedPairs.size > 0
              ? `, rates for ${[...approximatedPairs].sort().join(", ")}`
              : ""),
        );
      }

      result.set(account.id, {
        // An account holding nothing is worth zero, not unknown -- the
        // aggregate returns 0 for that case and it stays complete.
        marketValue: complete ? knownSubtotal : null,
        knownMarketValueSubtotal: knownSubtotal,
        unpricedHoldingsCount: unpriced.size,
        missingRatePairs,
        pricesComplete: unpriced.size === 0,
        fxComplete: aggregate.isComplete,
        valuationComplete: complete,
        approximatedPriceCount: approximatedPrices.size,
        approximatedRatePairs: [...approximatedPairs].sort(),
      });
    }

    return result;
  }

  /**
   * The rate map the report converts with, after giving the provider a chance
   * to supply what nobody has stored yet, and then the database a chance to
   * supply the closest thing it holds.
   *
   * A stored rate inside the window is preferred without qualification -- the
   * fetch only ever runs for pairs the database cannot answer at all for
   * `marketDate`. When the fetch comes back with something, the map is re-read
   * from the database rather than patched in memory, so what the report
   * converts with is exactly what a second request would find: one source of
   * truth, not two that agree today.
   *
   * The fetch is best-effort. What it cannot supply falls back to the closest
   * observation either side of the date (spec section 7.2) -- a real rate,
   * struck on another day, returned with that day so the report can say so. A
   * pair with no stored rate at *any* date has nothing to approximate from and
   * stays missing, which is what leaves the total null.
   */
  private async ratesForReport(
    required: Array<{ from: string; to: string }>,
    marketDate: string,
  ): Promise<ResolvedRates> {
    const rates = await this.storedRatesAsOf(marketDate);

    // `convertWithRateLookup` is the one place that decides a pair is
    // answerable -- direct rate, else the reciprocal of the reverse. Asking it
    // means the set fetched is exactly the set the valuation would fail on.
    const unanswerable = (map: Map<string, number>) =>
      required.filter(
        (pair) =>
          convertWithRateLookup(1, pair.from, pair.to, (f, t) =>
            map.get(`${f}->${t}`),
          ) === null,
      );

    const missing = unanswerable(rates);
    if (missing.length === 0) return { rates, approximated: new Map() };

    this.logger.log(
      `No stored rate at ${marketDate} for ${missing
        .map((p) => `${p.from}->${p.to}`)
        .sort()
        .join(", ")}; fetching historical rates`,
    );

    let loaded = 0;
    try {
      loaded = await this.exchangeRates.ensureRatesForDate(missing, marketDate);
    } catch (error) {
      this.logger.warn(
        `Historical rate fetch for ${marketDate} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const settled = loaded > 0 ? await this.storedRatesAsOf(marketDate) : rates;

    return this.withNearestRates(settled, unanswerable(settled), marketDate);
  }

  /**
   * The rate map widened with the closest observation either side of the date,
   * for the pairs nothing else could answer.
   *
   * The approximations are added to the same map the bounded rates live in --
   * one map, so `convertWithRateLookup` keeps making the one direct-then-
   * inverse decision -- with a parallel map naming which keys they are and when
   * they were struck. Nothing here overwrites a rate that stood on the date:
   * only pairs already established as unanswerable are asked for.
   */
  private async withNearestRates(
    rates: Map<string, number>,
    stillMissing: Array<{ from: string; to: string }>,
    marketDate: string,
  ): Promise<ResolvedRates> {
    const approximated = new Map<string, string>();
    if (stillMissing.length === 0) return { rates, approximated };

    const nearest = await nearestRatesFor(
      (sql, params) => this.scopedQuery(sql, params),
      stillMissing,
      marketDate,
    );
    if (nearest.size === 0) {
      this.logger.warn(
        `No stored rate at any date for ${stillMissing
          .map((p) => `${p.from}->${p.to}`)
          .sort()
          .join(", ")}; those figures stay unknown`,
      );
      return { rates, approximated };
    }

    const widened = new Map(rates);
    for (const [pair, observation] of nearest) {
      widened.set(pair, observation.value);
      approximated.set(pair, observation.date);
    }
    this.logger.log(
      `Using the closest stored rate to ${marketDate} for ${[...approximated]
        .map(([pair, date]) => `${pair} (${date})`)
        .sort()
        .join(", ")}`,
    );
    return { rates: widened, approximated };
  }

  /**
   * The closes the report values with, after giving the provider a chance to
   * supply the history nobody has stored yet, and then the database a chance to
   * supply the closest thing it holds.
   *
   * The exact counterpart of `ratesForReport`, and deliberately shaped the
   * same: only securities `closeAt` cannot answer for `marketDate` are asked
   * for, the fetch is best-effort, what it returns is re-read from the database
   * rather than patched into the map, and whatever is still missing falls back
   * to the nearest stored close either side of the date (spec section 4.2).
   *
   * A security refused by the *staleness bound* is asked for as well as one
   * with no rows at all, and it has to be: "the last close is from 2016" and
   * "there are no closes" are the same absence from a 2017 report's point of
   * view, and the fill is what tells them apart. A security with no close at
   * *any* date has nothing to approximate from and stays unpriced.
   */
  private async pricesForReport(
    heldSecurityIds: string[],
    stored: Map<string, number>,
    marketDate: string,
  ): Promise<ResolvedPrices> {
    const missing = heldSecurityIds.filter((id) => !stored.has(id));
    if (missing.length === 0)
      return { prices: stored, approximated: new Map() };

    this.logger.log(
      `No accepted close at ${marketDate} for ${missing.length} held securities; fetching historical prices`,
    );

    let loaded = 0;
    try {
      loaded = await this.securityPrices.ensurePricesForDate(
        missing,
        marketDate,
      );
    } catch (error) {
      this.logger.warn(
        `Historical price fetch for ${marketDate} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const settled =
      loaded > 0
        ? await this.closingPricesAsOf(heldSecurityIds, marketDate)
        : stored;

    return this.withNearestPrices(
      settled,
      heldSecurityIds.filter((id) => !settled.has(id)),
      marketDate,
    );
  }

  /**
   * The price map widened with the closest close either side of the date, for
   * the securities nothing else could price.
   *
   * Same contract as `withNearestRates`: only securities already established as
   * unpriced are looked up, so no close that stood on the date is displaced,
   * and each approximation is returned with the day it was struck on.
   */
  private async withNearestPrices(
    prices: Map<string, number>,
    stillMissing: string[],
    marketDate: string,
  ): Promise<ResolvedPrices> {
    const approximated = new Map<string, string>();
    if (stillMissing.length === 0) return { prices, approximated };

    const nearest = await nearestClosesFor(
      (sql, params) => this.scopedQuery(sql, params),
      stillMissing,
      marketDate,
    );
    if (nearest.size === 0) {
      this.logger.warn(
        `No stored close at any date for ${stillMissing.length} held securities; those positions stay unpriced`,
      );
      return { prices, approximated };
    }

    const widened = new Map(prices);
    for (const [securityId, observation] of nearest) {
      widened.set(securityId, observation.value);
      approximated.set(securityId, observation.date);
    }
    this.logger.log(
      `Using the closest stored close to ${marketDate} for ${approximated.size} held securities`,
    );
    return { prices: widened, approximated };
  }

  /** The currency the user reads their totals in. */
  private async resolveDisplayCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preferredCurrency(preference);
  }

  /**
   * The multiplier from each account currency to `displayCurrency`, as the rate
   * stood on the report's date -- and which of those multipliers is an
   * approximation.
   *
   * A point-in-time report converts at that point in time: asked what an
   * account held in 2019, "what it was worth then" is the question, and today's
   * rate answers a different one. The rates travel in the payload beside the
   * figures for the same reason the date does -- a consumer converting with a
   * live rate map would be presenting one date's balances at another date's
   * rates, and nothing on screen would say so.
   *
   * A currency with no rate at any date is **omitted**, never given 1. One
   * converted at the closest observation outside the window is present, and
   * named in `approximated` with the day that observation was struck: the
   * figure is real and the user is told which day it came from. The display
   * currency itself is present at 1 because that is a definition, not a
   * fallback, and it has to stay distinguishable from the absent case.
   */
  private displayRates(
    accountCurrencies: string[],
    displayCurrency: string,
    rates: ResolvedRates,
    asOfDate: string,
  ): { rates: Record<string, number>; approximated: Record<string, string> } {
    const resolved: Record<string, number> = { [displayCurrency]: 1 };
    const approximated: Record<string, string> = {};
    const missing = new Set<string>();
    for (const currency of new Set(accountCurrencies)) {
      if (currency === displayCurrency) continue;
      const rate = convertWithRateLookup(1, currency, displayCurrency, (f, t) =>
        rates.rates.get(`${f}->${t}`),
      );
      if (rate === null) {
        missing.add(`${currency}->${displayCurrency}`);
        continue;
      }
      resolved[currency] = rate;
      const approximatedOn = approximateRateDate(
        rates,
        currency,
        displayCurrency,
      );
      if (approximatedOn) approximated[currency] = approximatedOn;
    }
    if (missing.size > 0) {
      this.logger.warn(
        `No exchange rate at ${asOfDate} for ${[...missing].sort().join(", ")}; accounts in those currencies cannot be presented in ${displayCurrency}`,
      );
    }
    return { rates: resolved, approximated };
  }

  /**
   * Each security's close standing for `asOfDate`, through the one door.
   *
   * `closeAt` is what applies the staleness bound (`docs/time-series-contract.md`
   * section 2.1): a security last quoted months before the date has no price
   * *for that date*, and answering with the old close would report an
   * instrument as having gone nowhere since. Absent here means unpriced, which
   * the caller turns into a null account total rather than a smaller one.
   *
   * The query is bounded on both sides for the same reason -- it loads exactly
   * the window `closeAt` can accept, so the door and the read agree.
   */
  private async closingPricesAsOf(
    securityIds: string[],
    asOfDate: string,
  ): Promise<Map<string, number>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{
      security_id: string;
      price_date: string;
      close_price: string;
    }> = await this.scopedQuery(
      `SELECT security_id, price_date::text AS price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date >= $3
            AND price_date <= $2
          ORDER BY security_id, price_date ASC`,
      [securityIds, asOfDate, withLeadDays(asOfDate, BOUNDARY_LAG_DAYS)],
    );

    const series = new Map<string, PricePoint[]>();
    for (const row of rows) {
      const points = series.get(row.security_id);
      const point = { date: row.price_date, close: Number(row.close_price) };
      if (points) {
        points.push(point);
      } else {
        series.set(row.security_id, [point]);
      }
    }

    const prices = new Map<string, number>();
    for (const [securityId, points] of series) {
      const close = closeAt(points, asOfDate);
      if (close !== null) prices.set(securityId, close);
    }
    return prices;
  }

  private async securityCurrencies(
    securityIds: string[],
  ): Promise<Map<string, string>> {
    if (securityIds.length === 0) return new Map();
    const rows: Array<{ id: string; currency_code: string }> =
      await this.scopedQuery(
        `SELECT id, currency_code FROM securities WHERE id = ANY($1::UUID[])`,
        [securityIds],
      );
    return new Map(rows.map((r) => [r.id, r.currency_code]));
  }

  /**
   * The rate standing for `asOfDate` for every pair, keyed `"FROM->TO"`.
   * `convertWithRateLookup` tries the reverse pair itself, so only one
   * direction needs to exist.
   *
   * A rate is an observation on a date exactly as a close is, so it goes
   * through the same door and the same staleness bound: a pair last quoted
   * long before the date has no rate *for* it, and the caller reports the pair
   * as missing rather than converting at a number from another era.
   */
  private async storedRatesAsOf(
    asOfDate: string,
  ): Promise<Map<string, number>> {
    const rows: Array<{
      from_currency: string;
      to_currency: string;
      rate_date: string;
      rate: string;
    }> = await this.scopedQuery(
      `SELECT from_currency, to_currency, rate_date::text AS rate_date, rate
         FROM exchange_rates
        WHERE rate_date >= $2
          AND rate_date <= $1
        ORDER BY from_currency, to_currency, rate_date ASC`,
      [asOfDate, withLeadDays(asOfDate, BOUNDARY_LAG_DAYS)],
    );

    const series = new Map<string, PricePoint[]>();
    for (const row of rows) {
      const key = `${row.from_currency}->${row.to_currency}`;
      const points = series.get(key);
      const point = { date: row.rate_date, close: Number(row.rate) };
      if (points) {
        points.push(point);
      } else {
        series.set(key, [point]);
      }
    }

    const rates = new Map<string, number>();
    for (const [pair, points] of series) {
      const rate = closeAt(points, asOfDate);
      if (rate !== null) rates.set(pair, rate);
    }
    return rates;
  }
}
