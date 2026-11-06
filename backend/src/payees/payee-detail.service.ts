import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney } from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { PayeesService } from "./payees.service";
import { countUncategorizedTransactionsForPayee } from "./payee-backfill.util";
import { restrictToAccountScope } from "../delegation/delegate-account-scope.util";
import {
  PayeeAccountBreakdownRow,
  PayeeDetailDto,
  PayeeDetailStats,
  PayeeLargestTransaction,
} from "./dto/payee-detail.dto";

/**
 * The transaction scope every figure in this service is computed over: real
 * rows only. Void transactions never happened, and a split parent's amount is
 * carried by the parent row itself (children are excluded so nothing counts
 * twice). This mirrors the analytics service's scope, so the counts here agree
 * with the summary and grouped-totals endpoints the detail page also calls.
 */
function realTransactionScope(
  qb: ReturnType<EntityManager["createQueryBuilder"]>,
) {
  return qb
    .andWhere("t.status != 'VOID'")
    .andWhere("t.parent_transaction_id IS NULL");
}

/**
 * A DATE column selected as `yyyy-MM-dd` text.
 *
 * Raw selects bypass the entity's date transformer, so a DATE arrives as
 * whatever the driver's type parser makes of it -- a JS `Date` unless the
 * process happens to have installed the string parser `main.ts` sets. Formatting
 * in Postgres makes the column text for every caller, which is what the DTO
 * promises, and keeps the day from shifting through a timezone on the way out.
 */
function dateText(expression: string): string {
  return `TO_CHAR(${expression}, 'YYYY-MM-DD')`;
}

/**
 * The facts the payee detail page needs that no generic analytics endpoint can
 * produce: lifetime first/last dates, the per-account breakdown, the largest
 * transaction, and the payee's own housekeeping counts.
 *
 * Deliberately identity-and-facts only. Spending over time, category
 * breakdowns and recurring cadence all come from the transactions analytics
 * endpoints, which already accept a payee filter -- recomputing any of that
 * here would let this page drift from the register and the reports. Currency
 * conversion is likewise absent on purpose: every amount is in the currency of
 * the row it came from, and the client owns display currency.
 *
 * `accountScope` narrows every transaction figure and the overpayment account
 * list to those accounts (an acting delegate's READ grants, from
 * `delegateReadableAccountScope`); `undefined` means the whole ledger, and an
 * empty scope yields none.
 */
@Injectable()
export class PayeeDetailService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly payeesService: PayeesService,
  ) {}

  async getDetail(
    userId: string,
    payeeId: string,
    accountScope?: readonly string[],
  ): Promise<PayeeDetailDto> {
    // Validates ownership and existence (localized 404), loads defaultCategory.
    const payee = await this.payeesService.findOne(userId, payeeId);

    return withScopedDb(this.dataSource, async (m) => {
      const stats = await this.getStats(m, userId, payeeId, accountScope);
      const accounts = await this.getAccountBreakdown(
        m,
        userId,
        payeeId,
        accountScope,
      );
      const largestTransaction = await this.getLargestTransaction(
        m,
        userId,
        payeeId,
        accountScope,
      );
      const overpaymentForAccounts = await this.getOverpaymentAccounts(
        m,
        userId,
        payeeId,
        accountScope,
      );

      return {
        payee,
        stats,
        accounts,
        largestTransaction,
        overpaymentForAccounts,
      };
    });
  }

  private async getStats(
    m: EntityManager,
    userId: string,
    payeeId: string,
    accountScope: readonly string[] | undefined,
  ): Promise<PayeeDetailStats> {
    const row = await restrictToAccountScope(
      realTransactionScope(
        m
          .createQueryBuilder(Transaction, "t")
          .select("COUNT(*)", "count")
          .addSelect(dateText("MIN(t.transaction_date)"), "first")
          .addSelect(dateText("MAX(t.transaction_date)"), "last")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.payee_id = :payeeId", { payeeId }),
      ),
      "t.account_id",
      accountScope,
    ).getRawOne<{ count: string; first: string | null; last: string | null }>();

    const uncategorizedCount = await countUncategorizedTransactionsForPayee(
      m,
      userId,
      payeeId,
      accountScope,
    );
    const aliasCount = await m
      .getRepository(PayeeAlias)
      .count({ where: { userId, payeeId } });

    return {
      transactionCount: parseInt(row?.count ?? "0", 10),
      firstTransactionDate: row?.first ?? null,
      lastTransactionDate: row?.last ?? null,
      uncategorizedCount,
      aliasCount,
    };
  }

  private async getAccountBreakdown(
    m: EntityManager,
    userId: string,
    payeeId: string,
    accountScope: readonly string[] | undefined,
  ): Promise<PayeeAccountBreakdownRow[]> {
    const rows = await restrictToAccountScope(
      realTransactionScope(
        m
          .createQueryBuilder(Transaction, "t")
          .innerJoin(Account, "account", "account.id = t.account_id")
          .select("account.id", "accountId")
          .addSelect("account.name", "accountName")
          .addSelect("account.account_type", "accountType")
          .addSelect("account.currency_code", "currencyCode")
          .addSelect("COUNT(*)", "transactionCount")
          .addSelect("SUM(t.amount)", "total")
          .addSelect(dateText("MAX(t.transaction_date)"), "lastTransactionDate")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.payee_id = :payeeId", { payeeId }),
      ),
      "t.account_id",
      accountScope,
    )
      .groupBy("account.id")
      .addGroupBy("account.name")
      .addGroupBy("account.account_type")
      .addGroupBy("account.currency_code")
      .orderBy("COUNT(*)", "DESC")
      .getRawMany<{
        accountId: string;
        accountName: string;
        accountType: string;
        currencyCode: string;
        transactionCount: string;
        total: string;
        lastTransactionDate: string | null;
      }>();

    // Each total is in its account's currency, rounded at its precision.
    const places = await loadCurrencyPlacesForRead(
      m,
      rows.map((row) => row.currencyCode),
    );
    return rows.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      accountType: row.accountType,
      currencyCode: row.currencyCode,
      transactionCount: parseInt(row.transactionCount, 10),
      total: roundMoney(
        Number(row.total),
        moneyDecimalsForCode(places, row.currencyCode),
      ),
      lastTransactionDate: row.lastTransactionDate ?? null,
    }));
  }

  private async getLargestTransaction(
    m: EntityManager,
    userId: string,
    payeeId: string,
    accountScope: readonly string[] | undefined,
  ): Promise<PayeeLargestTransaction | null> {
    const row = await restrictToAccountScope(
      realTransactionScope(
        m
          .createQueryBuilder(Transaction, "t")
          .innerJoin(Account, "account", "account.id = t.account_id")
          .select("t.id", "id")
          .addSelect(dateText("t.transaction_date"), "transactionDate")
          .addSelect("t.amount", "amount")
          .addSelect("t.currency_code", "currencyCode")
          .addSelect("t.description", "description")
          .addSelect("account.id", "accountId")
          .addSelect("account.name", "accountName")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.payee_id = :payeeId", { payeeId }),
      ),
      "t.account_id",
      accountScope,
    )
      .orderBy("ABS(t.amount)", "DESC")
      .addOrderBy("t.transaction_date", "DESC")
      .limit(1)
      .getRawOne<{
        id: string;
        transactionDate: string;
        amount: string;
        currencyCode: string;
        description: string | null;
        accountId: string;
        accountName: string;
      }>();

    if (!row) {
      return null;
    }

    const places = await loadCurrencyPlacesForRead(m, [row.currencyCode]);
    return {
      id: row.id,
      transactionDate: row.transactionDate,
      amount: roundMoney(
        Number(row.amount),
        moneyDecimalsForCode(places, row.currencyCode),
      ),
      currencyCode: row.currencyCode,
      accountId: row.accountId,
      accountName: row.accountName,
      description: row.description ?? null,
    };
  }

  private async getOverpaymentAccounts(
    m: EntityManager,
    userId: string,
    payeeId: string,
    accountScope: readonly string[] | undefined,
  ): Promise<{ accountId: string; accountName: string }[]> {
    if (accountScope !== undefined && accountScope.length === 0) return [];
    const rows = await m.getRepository(Account).find({
      where: {
        userId,
        overpaymentPayeeId: payeeId,
        ...(accountScope ? { id: In([...accountScope]) } : {}),
      },
      select: ["id", "name"],
      order: { name: "ASC" },
    });
    return rows.map((account) => ({
      accountId: account.id,
      accountName: account.name,
    }));
  }
}
