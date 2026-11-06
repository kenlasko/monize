import { Injectable } from "@nestjs/common";
import { Brackets, DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney } from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { restrictToAccountScope } from "../delegation/delegate-account-scope.util";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Category } from "./entities/category.entity";
import { CategoriesService } from "./categories.service";
import {
  CategoryAccountBreakdownRow,
  CategoryDetailDto,
  CategoryDetailStats,
  CategoryLargestTransaction,
} from "./dto/category-detail.dto";

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
 * The facts the category detail page needs that no generic analytics endpoint
 * can produce: lifetime first/last dates, the per-account breakdown, the
 * largest transaction, and the category's own housekeeping counts.
 *
 * Deliberately identity-and-facts only. Spending over time, payee breakdowns
 * and subcategory shares all come from the transactions analytics endpoints,
 * which already accept a category filter -- recomputing any of that here would
 * let this page drift from the register and the reports. Currency conversion
 * is likewise absent on purpose: every amount is in the currency of the row it
 * came from, and the client owns display currency.
 *
 * Every figure covers the whole subtree, because that is what every analytics
 * endpoint and the register do with a category filter (descendant expansion via
 * getAllCategoryIdsWithChildren) -- a "Transactions: 412" card must agree with
 * the register the View Transactions button opens. A transaction counts when
 * its own category matches or any of its split lines does, and its money
 * contribution is the matching split's amount when the match came from a split.
 *
 * The "transfer"/"uncategorized" pseudo-ids the analytics endpoints accept can
 * never reach this service: the controller's ParseUUIDPipe rejects them. And
 * `Account.assetCategoryId` points at an ordinary user category, so no special
 * exclusion exists or is needed here.
 *
 * `accountScope` narrows every transaction figure to those accounts (an acting
 * delegate's READ grants, from `delegateReadableAccountScope`); `undefined`
 * means the whole ledger, and an empty scope yields no transactions.
 */
@Injectable()
export class CategoryDetailService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly categoriesService: CategoriesService,
  ) {}

  async getDetail(
    userId: string,
    categoryId: string,
    accountScope?: readonly string[],
  ): Promise<CategoryDetailDto> {
    // Validates ownership and existence (localized 404), loads children and
    // the effective (possibly inherited) colour.
    const category = await this.categoriesService.findOne(userId, categoryId);

    return withScopedDb(this.dataSource, async (m) => {
      const subtreeIds = await getAllCategoryIdsWithChildren(
        m.getRepository(Category),
        userId,
        [categoryId],
      );

      const stats = await this.getStats(
        m,
        userId,
        subtreeIds,
        category,
        accountScope,
      );
      const accounts = await this.getAccountBreakdown(
        m,
        userId,
        subtreeIds,
        accountScope,
      );
      const largestTransaction = await this.getLargestTransaction(
        m,
        userId,
        subtreeIds,
        accountScope,
      );
      const defaultCategoryForPayees = await this.getDefaultCategoryPayees(
        m,
        userId,
        categoryId,
      );

      return {
        category,
        stats,
        accounts,
        largestTransaction,
        defaultCategoryForPayees,
      };
    });
  }

  /**
   * Base query for every subtree figure: real transactions joined to their
   * split lines, kept when the transaction's own category or a split line's
   * category is in the subtree. Transfer split lines are excluded exactly as
   * the analytics summary excludes them -- they move money between own
   * accounts and are not spending or income.
   *
   * The join can yield several rows per transaction (one per matching split),
   * so counts must use COUNT(DISTINCT t.id) while sums take the per-row
   * COALESCE(split.amount, t.amount) -- for a split parent the matching
   * splits' amounts are the category's share; the parent's own amount would
   * include other categories' money.
   */
  private subtreeTransactionQuery(
    m: EntityManager,
    userId: string,
    subtreeIds: string[],
    accountScope: readonly string[] | undefined,
  ) {
    const scoped = realTransactionScope(
      m
        .createQueryBuilder(Transaction, "t")
        .leftJoin("t.splits", "split")
        .where("t.user_id = :userId", { userId })
        .andWhere("(split.transfer_account_id IS NULL OR split.id IS NULL)")
        .andWhere(
          new Brackets((qb) => {
            qb.where("t.category_id IN (:...subtreeIds)", {
              subtreeIds,
            }).orWhere("split.category_id IN (:...subtreeIds)", {
              subtreeIds,
            });
          }),
        ),
    );
    return restrictToAccountScope(scoped, "t.account_id", accountScope);
  }

  private async getStats(
    m: EntityManager,
    userId: string,
    subtreeIds: string[],
    category: Category & { children?: Category[] },
    accountScope: readonly string[] | undefined,
  ): Promise<CategoryDetailStats> {
    const row = await this.subtreeTransactionQuery(
      m,
      userId,
      subtreeIds,
      accountScope,
    )
      .select("COUNT(DISTINCT t.id)", "count")
      .addSelect(dateText("MIN(t.transaction_date)"), "first")
      .addSelect(dateText("MAX(t.transaction_date)"), "last")
      .addSelect("COUNT(DISTINCT t.payee_id)", "payeeCount")
      .getRawOne<{
        count: string;
        first: string | null;
        last: string | null;
        payeeCount: string;
      }>();

    return {
      transactionCount: parseInt(row?.count ?? "0", 10),
      firstTransactionDate: row?.first ?? null,
      lastTransactionDate: row?.last ?? null,
      payeeCount: parseInt(row?.payeeCount ?? "0", 10),
      subcategoryCount: category.children?.length ?? 0,
    };
  }

  private async getAccountBreakdown(
    m: EntityManager,
    userId: string,
    subtreeIds: string[],
    accountScope: readonly string[] | undefined,
  ): Promise<CategoryAccountBreakdownRow[]> {
    const rows = await this.subtreeTransactionQuery(
      m,
      userId,
      subtreeIds,
      accountScope,
    )
      .innerJoin(Account, "account", "account.id = t.account_id")
      .select("account.id", "accountId")
      .addSelect("account.name", "accountName")
      .addSelect("account.account_type", "accountType")
      .addSelect("account.currency_code", "currencyCode")
      .addSelect("COUNT(DISTINCT t.id)", "transactionCount")
      .addSelect("SUM(COALESCE(split.amount, t.amount))", "total")
      .addSelect(dateText("MAX(t.transaction_date)"), "lastTransactionDate")
      .groupBy("account.id")
      .addGroupBy("account.name")
      .addGroupBy("account.account_type")
      .addGroupBy("account.currency_code")
      .orderBy("COUNT(DISTINCT t.id)", "DESC")
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
    subtreeIds: string[],
    accountScope: readonly string[] | undefined,
  ): Promise<CategoryLargestTransaction | null> {
    const row = await this.subtreeTransactionQuery(
      m,
      userId,
      subtreeIds,
      accountScope,
    )
      .innerJoin(Account, "account", "account.id = t.account_id")
      .leftJoin(Payee, "payee", "payee.id = t.payee_id")
      .select("t.id", "id")
      .addSelect(dateText("t.transaction_date"), "transactionDate")
      .addSelect("COALESCE(split.amount, t.amount)", "amount")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect("t.description", "description")
      .addSelect("COALESCE(payee.name, t.payee_name)", "payeeName")
      .addSelect("account.id", "accountId")
      .addSelect("account.name", "accountName")
      .orderBy("ABS(COALESCE(split.amount, t.amount))", "DESC")
      .addOrderBy("t.transaction_date", "DESC")
      .limit(1)
      .getRawOne<{
        id: string;
        transactionDate: string;
        amount: string;
        currencyCode: string;
        description: string | null;
        payeeName: string | null;
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
      payeeName: row.payeeName ?? null,
    };
  }

  private async getDefaultCategoryPayees(
    m: EntityManager,
    userId: string,
    categoryId: string,
  ): Promise<{ payeeId: string; payeeName: string }[]> {
    const rows = await m.getRepository(Payee).find({
      where: { userId, defaultCategoryId: categoryId },
      select: ["id", "name"],
      order: { name: "ASC" },
    });
    return rows.map((payee) => ({ payeeId: payee.id, payeeName: payee.name }));
  }
}
