import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { computeStatementCycle } from "./statement-cycle.util";
import { roundMoney } from "../common/round.util";
import { todayYMD } from "../common/date-utils";
import { tr } from "../i18n/translate";

export interface StatementCycleResult {
  accountId: string;
  currencyCode: string;
  cycleStart: string;
  cycleEnd: string;
  lastSettlementDate: string;
  nextSettlementDate: string;
  daysUntilSettlement: number;
  paymentDueDate: string | null;
  daysUntilPaymentDue: number | null;
  /**
   * Ending balance of the last reconciled statement: the opening balance plus
   * every reconciled transaction (same sign as currentBalance). Unreconciled
   * current-cycle activity is excluded, so this is what was owed when the last
   * statement closed, not the live balance.
   */
  statementBalance: number;
  /** Date of the most recent reconciliation, or null when nothing is reconciled. */
  statementBalanceDate: string | null;
  /** Payments/credits made since the last reconciled statement (unreconciled, positive). */
  amountPaidSinceStatement: number;
  /**
   * Expenses (charges) incurred since the last reconciled statement (positive
   * magnitude) -- i.e. unreconciled charges that are not yet on a closed
   * statement.
   */
  expensesSinceStatement: number;
  /** The account's current balance (same sign convention). */
  currentBalance: number;
}

export interface InterestPaidResult {
  amount: number;
  count: number;
}

/**
 * Computes credit-card statement-cycle boundaries and statement figures from
 * the account's day-of-month statement fields and its transaction history.
 * Pure date math lives in `statement-cycle.util.ts`; this service adds the
 * ownership check and the balance aggregation.
 */
@Injectable()
export class StatementCycleService {
  constructor(
    @InjectRepository(Account)
    private readonly accountsRepository: Repository<Account>,
    private readonly dataSource: DataSource,
  ) {}

  private async loadOwnedAccount(
    userId: string,
    accountId: string,
  ): Promise<Account> {
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
    return account;
  }

  async getStatementCycle(
    userId: string,
    accountId: string,
  ): Promise<StatementCycleResult> {
    const account = await this.loadOwnedAccount(userId, accountId);

    if (account.accountType !== AccountType.CREDIT_CARD) {
      throw new BadRequestException(
        tr(
          "errors.accounts.notACreditCard",
          "Statement cycles are only available for credit card accounts",
        ),
      );
    }
    if (account.statementSettlementDay == null) {
      throw new BadRequestException(
        tr(
          "errors.accounts.noStatementSettlementDay",
          "This credit card has no statement settlement day configured",
        ),
      );
    }

    const dates = computeStatementCycle(
      account.statementSettlementDay,
      account.statementDueDay,
      todayYMD(),
    );

    const rows: {
      statement_balance: string;
      statement_balance_date: string | null;
      amount_paid: string;
      expenses_since_statement: string;
    }[] = await this.dataSource.query(
      `SELECT
           COALESCE(a.opening_balance, 0)
             + COALESCE(SUM(CASE WHEN t.status = 'RECONCILED' THEN t.amount ELSE 0 END), 0)
             AS statement_balance,
           MAX(CASE WHEN t.status = 'RECONCILED' THEN t.reconciled_date END)
             AS statement_balance_date,
           COALESCE(SUM(CASE
             WHEN (t.status IS NULL OR t.status != 'RECONCILED') AND t.amount > 0
             THEN t.amount ELSE 0 END), 0)
             AS amount_paid,
           COALESCE(SUM(CASE
             WHEN (t.status IS NULL OR t.status != 'RECONCILED') AND t.amount < 0
             THEN -t.amount ELSE 0 END), 0)
             AS expenses_since_statement
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND t.user_id = $2
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
         WHERE a.id = $1 AND a.user_id = $2
         GROUP BY a.id, a.opening_balance`,
      [accountId, userId],
    );

    const row = rows?.[0];
    return {
      accountId,
      currencyCode: account.currencyCode,
      cycleStart: dates.cycleStart,
      cycleEnd: dates.cycleEnd,
      lastSettlementDate: dates.lastSettlementDate,
      nextSettlementDate: dates.nextSettlementDate,
      daysUntilSettlement: dates.daysUntilSettlement,
      paymentDueDate: dates.paymentDueDate,
      daysUntilPaymentDue: dates.daysUntilPaymentDue,
      statementBalance: roundMoney(
        Number(row?.statement_balance ?? account.openingBalance),
      ),
      statementBalanceDate: row?.statement_balance_date ?? null,
      amountPaidSinceStatement: roundMoney(Number(row?.amount_paid ?? 0)),
      expensesSinceStatement: roundMoney(
        Number(row?.expenses_since_statement ?? 0),
      ),
      currentBalance: roundMoney(Number(account.currentBalance)),
    };
  }

  /**
   * Total interest/fees charged to a card in a date range. Interest categories
   * are detected by name (an "interest" substring), matching the loan and
   * banking heuristics. Returns the charged amount as a positive magnitude.
   */
  async getInterestPaid(
    userId: string,
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<InterestPaidResult> {
    await this.loadOwnedAccount(userId, accountId);

    const rows: { amount: string; count: string }[] =
      await this.dataSource.query(
        `SELECT COALESCE(SUM(-t.amount), 0) AS amount, COUNT(*) AS count
       FROM transactions t
       JOIN categories c ON c.id = t.category_id
       WHERE t.account_id = $1
         AND t.user_id = $2
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
         AND t.amount < 0
         AND t.transaction_date >= $3
         AND t.transaction_date <= $4
         AND c.name ILIKE '%interest%'`,
        [accountId, userId, startDate, endDate],
      );

    const row = rows?.[0];
    return {
      amount: roundMoney(Number(row?.amount ?? 0)),
      count: Number(row?.count ?? 0),
    };
  }
}
