import {
  Injectable,
  NotFoundException,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import {
  ResolvedScheduledOccurrence,
  ScheduledOccurrenceService,
} from "../scheduled-transactions/scheduled-occurrence.service";
import {
  BalanceForecastGap,
  BalanceForecastOverdue,
  ForecastOccurrenceInput,
  ForecastPoint,
  accumulateForecastDeltas,
  buildForecastSeries,
  forecastLanding,
} from "./balance-forecast.util";
import { roundMoney } from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { overdueCarryFrom } from "../common/scheduled-occurrences";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";

export interface BalanceForecastResult {
  accountId: string;
  currencyCode: string;
  /**
   * The projected series. When `complete` is false this holds only today's
   * anchor -- a running balance is cumulative, so one occurrence nobody can
   * price makes every point after it wrong, and a plausible line is worse than
   * no line (`docs/financial-semantics.md`, issue #1247).
   */
  points: ForecastPoint[];
  /** False when any occurrence inside the horizon could not be priced. */
  complete: boolean;
  /** The schedules that made it incomplete, so the client can say which and why. */
  gaps: BalanceForecastGap[];
  /**
   * The occurrences due before today that were neither posted nor skipped, which
   * the series applies on its first projected day (discussion #1784); `null`
   * when there are none, or when the series is withheld and states nothing
   * after today.
   */
  overdue: BalanceForecastOverdue | null;
}

/**
 * Projects an account's balance forward from today, applying future-dated real
 * transactions and expanded scheduled-transaction occurrences. Complements the
 * historical daily-balances series, which only reflects real transactions.
 */
@Injectable()
export class BalanceForecastService {
  constructor(
    private readonly dataSource: DataSource,
    // Which occurrences fall inside the horizon, what each would post today, and
    // which account pays for it -- all from the one server-side occurrence
    // contract (issue #1247). Every half matters here: a scheduled investment's
    // `accountId` is the brokerage while its cash settles elsewhere, so a
    // projection keyed on that column charged the wrong account, and an
    // occurrence the user re-priced or moved is not the template's.
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private readonly occurrences: ScheduledOccurrenceService,
  ) {}

  async getBalanceForecast(
    userId: string,
    accountId: string,
    days = 90,
  ): Promise<BalanceForecastResult> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          {
            id: accountId,
          },
        ),
      );
    }

    const today = todayYMD();
    const horizon = addDaysYMD(today, days);

    // Balance as of end of today (excludes future-dated transactions), matching
    // the last point of the historical daily-balances series.
    const startRows: { balance: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT COALESCE(a.opening_balance, 0)
         + COALESCE(SUM(CASE WHEN t.transaction_date <= $3 THEN t.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND t.user_id = $2
         AND ${LEDGER_MOVEMENT_PREDICATE}
       WHERE a.id = $1 AND a.user_id = $2
       GROUP BY a.id, a.opening_balance`,
          [accountId, userId, today],
        ),
    );
    // Every figure of the projection is in the account's currency, rounded at
    // its precision: a coin wallet's satoshis survive the running balance.
    const places = await withScopedDb(this.dataSource, (m) =>
      loadCurrencyPlacesForRead(m, [account.currencyCode]),
    );
    const decimals = moneyDecimalsForCode(places, account.currencyCode);
    const startBalance = roundMoney(
      Number(startRows?.[0]?.balance ?? account.openingBalance),
      decimals,
    );

    // Future-dated real transactions per day.
    const actualRows: { date: string; total: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT t.transaction_date::TEXT AS date, SUM(t.amount)::NUMERIC AS total
       FROM transactions t
       WHERE t.account_id = $1
         AND t.user_id = $2
         AND ${LEDGER_MOVEMENT_PREDICATE}
         AND t.transaction_date > $3
         AND t.transaction_date <= $4
       GROUP BY t.transaction_date`,
          [accountId, userId, today, horizon],
        ),
    );
    const actualByDate = new Map<string, number>();
    for (const r of actualRows) actualByDate.set(r.date, Number(r.total));

    // Candidate schedules. The first two arms are the ones that name this
    // account directly; the third brings in every active investment schedule
    // regardless of account, because an investment's `accountId` is the
    // brokerage and its cash may settle *here* -- which the column cannot say.
    // Narrow on purpose: loading every schedule per chart would be a much wider
    // read for the same answer.
    const candidates = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).find({
        where: [
          { userId, isActive: true, accountId },
          { userId, isActive: true, transferAccountId: accountId },
          { userId, isActive: true, isInvestment: true },
        ],
        // The splits decide whether a schedule's cash total re-prices at the
        // current rate, which the effective-amount resolver cannot answer
        // without them.
        relations: ["splits"],
      }),
    );

    // Occurrences, not schedules: the expansion, the override selection and the
    // pricing all come from the one occurrence contract, so this chart cannot
    // disagree with the cash-flow forecast, the budget or the register about
    // which occurrence falls when and what it costs (issue #1247).
    //
    // From `OVERDUE_CARRY_DAYS` back: an occurrence already due and still
    // unposted is owed, and `forecastLanding` applies it on the first projected
    // day rather than on today's anchor, which stays the fact it is (discussion
    // #1784). An older one is read as forgotten and left out.
    const occurrences = await this.occurrences.expand(userId, candidates, {
      from: overdueCarryFrom(today),
      through: horizon,
    });

    const inputs: ForecastOccurrenceInput[] = [];
    for (const occurrence of occurrences) {
      const row = occurrence.schedule;
      // Charge the occurrence to the account that actually moves the cash.
      const isTransferTarget = row.transferAccountId === accountId;
      if (occurrence.settlementAccountId !== accountId && !isTransferTarget) {
        continue;
      }

      const gap = this.gapFor(occurrence, account, isTransferTarget);
      const landing = forecastLanding(occurrence.dueDate, today);
      inputs.push({
        scheduledTransactionId: occurrence.scheduledTransactionId,
        name: row.name,
        accountId: occurrence.settlementAccountId,
        transferAccountId: row.transferAccountId,
        dueDate: landing.date,
        overdue: landing.overdue,
        amount: gap ? null : occurrence.amount,
        gapReason: gap?.reason,
        gapFromCurrency: gap?.from ?? null,
        gapToCurrency: gap?.to ?? null,
      });
    }

    const { byDate, gaps, overdue } = accumulateForecastDeltas(
      inputs,
      accountId,
      actualByDate,
      decimals,
    );
    const complete = gaps.length === 0;
    const points = complete
      ? buildForecastSeries(startBalance, today, horizon, byDate, decimals)
      : // Today's balance is a known fact and stays; everything after it is not.
        [{ date: today, balance: startBalance }];

    return {
      accountId,
      currencyCode: account.currencyCode,
      points,
      complete,
      gaps,
      overdue:
        complete && overdue.count > 0
          ? { date: addDaysYMD(today, 1), ...overdue }
          : null,
    };
  }

  /**
   * Whether this occurrence can be projected onto `account` at all, and why not.
   *
   * Two ways it cannot, and neither may be papered over with the persisted
   * amount or an unconverted one (issue #1247):
   *
   *  - the occurrence could not be priced (an investment-carrying schedule whose
   *    current settlement rate is unknown, or an override in the same state);
   *  - the schedule is a transfer *into* this account from an account in another
   *    currency. Its `amount` is the source's, the arriving amount is resolved
   *    when it posts, and this endpoint applies no rate -- so adding the source
   *    figure would put a foreign number on this balance. That is a different
   *    defect from the stale snapshot and is reported under its own reason.
   *
   * The currency check on the priced case is deliberately a comparison rather
   * than an assumption: the occurrence's `currencyCode` is the settlement
   * account's currency by construction, so it should always equal this account's
   * -- and if that ever stops being true, the honest answer is a gap, not a
   * silent addition.
   */
  private gapFor(
    occurrence: ResolvedScheduledOccurrence,
    account: Account,
    isTransferTarget: boolean,
  ): {
    reason: BalanceForecastGap["reason"];
    from: string | null;
    to: string | null;
  } | null {
    const row = occurrence.schedule;
    if (isTransferTarget && row.currencyCode !== account.currencyCode) {
      return {
        reason: "crossCurrencyTransfer",
        from: row.currencyCode,
        to: account.currencyCode,
      };
    }
    if (occurrence.amount === null) {
      // Name the pair when there is one: "no rate from USD to CAD" is something
      // the reader can go and fix. A split parent's lines each settle their own
      // security's currency, so there is no single pair and the message says the
      // rate is unavailable without naming one.
      return {
        reason: "unresolvedSettlementRate",
        from: occurrence.settlementPair?.from ?? null,
        to: occurrence.settlementPair?.to ?? occurrence.currencyCode,
      };
    }
    if (!isTransferTarget && occurrence.currencyCode !== account.currencyCode) {
      return {
        reason: "unresolvedSettlementRate",
        from: occurrence.currencyCode,
        to: account.currencyCode,
      };
    }
    return null;
  }
}
