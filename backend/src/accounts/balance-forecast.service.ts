import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import {
  ForecastPoint,
  ForecastScheduleInput,
  accumulateForecastDeltas,
  addDaysYMD,
  buildForecastSeries,
} from "./balance-forecast.util";
import { roundMoney } from "../common/round.util";
import { todayYMD } from "../common/date-utils";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";

export interface BalanceForecastResult {
  accountId: string;
  currencyCode: string;
  points: ForecastPoint[];
}

/**
 * Projects an account's balance forward from today, applying future-dated real
 * transactions and expanded scheduled-transaction occurrences. Complements the
 * historical daily-balances series, which only reflects real transactions.
 */
@Injectable()
export class BalanceForecastService {
  constructor(
    @InjectRepository(Account)
    private readonly accountsRepository: Repository<Account>,
    @InjectRepository(ScheduledTransaction)
    private readonly scheduledRepository: Repository<ScheduledTransaction>,
    private readonly dataSource: DataSource,
  ) {}

  async getBalanceForecast(
    userId: string,
    accountId: string,
    days = 90,
  ): Promise<BalanceForecastResult> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId, userId },
    });
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
    const startRows: { balance: string }[] = await this.dataSource.query(
      `SELECT COALESCE(a.opening_balance, 0)
         + COALESCE(SUM(CASE WHEN t.transaction_date <= $3 THEN t.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND t.user_id = $2
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
       WHERE a.id = $1 AND a.user_id = $2
       GROUP BY a.id, a.opening_balance`,
      [accountId, userId, today],
    );
    const startBalance = roundMoney(
      Number(startRows?.[0]?.balance ?? account.openingBalance),
    );

    // Future-dated real transactions per day.
    const actualRows: { date: string; total: string }[] =
      await this.dataSource.query(
        `SELECT t.transaction_date::TEXT AS date, SUM(t.amount)::NUMERIC AS total
       FROM transactions t
       WHERE t.account_id = $1
         AND t.user_id = $2
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
         AND t.transaction_date > $3
         AND t.transaction_date <= $4
       GROUP BY t.transaction_date`,
        [accountId, userId, today, horizon],
      );
    const actualByDate = new Map<string, number>();
    for (const r of actualRows) actualByDate.set(r.date, Number(r.total));

    // Active schedules that hit this account directly or as a transfer target.
    const schedules = await this.scheduledRepository.find({
      where: [
        { userId, isActive: true, accountId },
        { userId, isActive: true, transferAccountId: accountId },
      ],
    });
    const inputs: ForecastScheduleInput[] = schedules.map((s) => ({
      accountId: s.accountId,
      transferAccountId: s.transferAccountId,
      amount: Number(s.amount),
      frequency: s.frequency,
      nextDueDate: ensureYMD(s.nextDueDate),
      endDate: s.endDate ? ensureYMD(s.endDate) : null,
      occurrencesRemaining: s.occurrencesRemaining,
    }));

    const deltaByDate = accumulateForecastDeltas(
      inputs,
      accountId,
      today,
      horizon,
      actualByDate,
    );
    const points = buildForecastSeries(
      startBalance,
      today,
      horizon,
      deltaByDate,
    );

    return { accountId, currencyCode: account.currencyCode, points };
  }
}
