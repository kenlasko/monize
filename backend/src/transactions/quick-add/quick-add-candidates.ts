/**
 * What the Quick Add reader reads against, loaded on the caller's
 * `withScopedDb` manager (`docs/future-plans/quick-add.md`, "Filling what
 * was not typed"). Every read is keyed on the caller's own `userId`: an
 * account shared through a joint grant is not a candidate, and the full form
 * handles it.
 */
import {
  categoryTypeOf,
  isTransferCategory,
} from "../../categories/category-type.util";
import { EntityManager, In, Not } from "typeorm";
import {
  Account,
  AccountSubType,
} from "../../accounts/entities/account.entity";
import { Category } from "../../categories/entities/category.entity";
import { qualifiedNamesById } from "../../categories/category-name.util";
import { Currency } from "../../currencies/entities/currency.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { PayeeAlias } from "../../payees/entities/payee-alias.entity";
import { loadSearchFormats } from "../apply-transaction-search";
import { Transaction, TransactionStatus } from "../entities/transaction.entity";
import type { HeldCurrency } from "./quick-add-currency.util";
import type {
  QuickAddPayeeHistory,
  QuickAddUsage,
} from "./quick-add-fill-shared.util";
import type {
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCandidatePayee,
} from "./quick-add.types";

/** How many of a payee's latest rows its history reads. */
export const PAYEE_HISTORY_ROWS = 10;

/**
 * The most ids one usage count asks about. A partial word can start
 * thousands of payee names, and every id is a bind parameter (PostgreSQL
 * refuses more than 65,535 in one statement); past the cap a candidate counts
 * as unused and ranks by name after the counted ones.
 */
export const USAGE_MAX_IDS = 500;

/**
 * Newest first. Rows written in one transaction share `created_at` (a
 * transfer's two legs, an import), so `id` breaks what the clock cannot and
 * the same ledger always reads the same way; which of the tied rows wins
 * carries no meaning.
 */
const HISTORY_ORDER = {
  transactionDate: "DESC",
  createdAt: "DESC",
  id: "DESC",
} as const;
const CREATED_ORDER = { createdAt: "DESC", id: "DESC" } as const;

export interface QuickAddCandidates {
  /**
   * Owned, open, not a brokerage and not a shared-expense settlement account
   * (any `managed_purpose`): the set `NormalTransactionFields` offers.
   */
  readonly accounts: readonly QuickAddCandidateAccount[];
  /** Active payees with their aliases. */
  readonly payees: readonly QuickAddCandidatePayee[];
  /** Every category the reader owns. */
  readonly categories: readonly QuickAddCandidateCategory[];
  readonly numberFormat: string;
  readonly dateFormat: string;
  /** The currencies the accounts are held in, with their symbols. */
  readonly currencies: readonly HeldCurrency[];
  /** `currencies.decimal_places` by upper-cased code. */
  readonly currencyPlaces: ReadonlyMap<string, number>;
}

export async function loadQuickAddCandidates(
  m: EntityManager,
  userId: string,
): Promise<QuickAddCandidates> {
  const accountRows = await m.getRepository(Account).find({
    where: { userId, isClosed: false },
    select: {
      id: true,
      name: true,
      currencyCode: true,
      currentBalance: true,
      accountSubType: true,
      managedPurpose: true,
    },
    order: { name: "ASC" },
  });
  const accounts = accountRows
    .filter(
      (a) =>
        a.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE &&
        !a.managedPurpose,
    )
    .map((a) => ({
      id: a.id,
      name: a.name,
      currencyCode: a.currencyCode,
      currentBalance: Number(a.currentBalance ?? 0),
    }));

  const payeeRows = await m.getRepository(Payee).find({
    where: { userId, isActive: true },
    select: { id: true, name: true, defaultCategoryId: true },
  });
  const aliasRows = await m.getRepository(PayeeAlias).find({
    where: { userId },
    select: { payeeId: true, alias: true },
  });
  // Each alias is appended in place: copying the payee's list for every alias
  // would cost the square of its alias count inside the scoped read.
  const aliasesByPayee = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasesByPayee.get(row.payeeId);
    if (list) list.push(row.alias);
    else aliasesByPayee.set(row.payeeId, [row.alias]);
  }
  const payees = payeeRows.map((p) => ({
    id: p.id,
    name: p.name,
    defaultCategoryId: p.defaultCategoryId ?? null,
    aliases: aliasesByPayee.get(p.id) ?? [],
  }));

  const categoryRows = await m.getRepository(Category).find({
    where: { userId },
    select: {
      id: true,
      name: true,
      parentId: true,
      categoryType: true,
    },
  });
  const paths = qualifiedNamesById(categoryRows);
  // A Transfer category goes only on a transfer, and a quick-add row that is
  // not one is an ordinary row (INV-CATEGORY-001): it is never a candidate.
  const categories = categoryRows
    .filter((c) => !isTransferCategory(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      path: paths.get(c.id) ?? c.name,
      categoryType: categoryTypeOf(c),
    }));

  const formats = await loadSearchFormats(m, userId);
  const codes = [...new Set(accounts.map((a) => a.currencyCode.toUpperCase()))];
  const currencyRows =
    codes.length === 0
      ? []
      : await m.getRepository(Currency).find({
          where: { code: In(codes) },
          select: { code: true, symbol: true, decimalPlaces: true },
        });

  return {
    accounts,
    payees,
    categories,
    numberFormat: formats.numberFormat || "en-US",
    dateFormat: formats.dateFormat || "YYYY-MM-DD",
    currencies: codes.map((code) => ({
      code,
      symbol:
        currencyRows.find((c) => c.code.toUpperCase() === code)?.symbol ?? null,
    })),
    currencyPlaces: new Map(
      currencyRows.map((c) => [c.code.toUpperCase(), Number(c.decimalPlaces)]),
    ),
  };
}

/** An owned payee, active or not, for a pin; null when it is not the caller's. */
export async function loadOwnedPayee(
  m: EntityManager,
  userId: string,
  payeeId: string,
): Promise<QuickAddCandidatePayee | null> {
  const row = await m.getRepository(Payee).findOne({
    where: { id: payeeId, userId },
    select: { id: true, name: true, defaultCategoryId: true },
  });
  return row
    ? {
        id: row.id,
        name: row.name,
        defaultCategoryId: row.defaultCategoryId ?? null,
        aliases: [],
      }
    : null;
}

/**
 * How many of the caller's non-void transactions name each of `ids` in
 * `column`: the first {@link USAGE_MAX_IDS} distinct ids, in the order given.
 */
export async function loadUsage(
  m: EntityManager,
  userId: string,
  column: "payee_id" | "category_id" | "account_id",
  ids: readonly string[],
): Promise<QuickAddUsage> {
  const asked = [...new Set(ids)].slice(0, USAGE_MAX_IDS);
  if (asked.length === 0) return new Map();
  const rows = await m
    .getRepository(Transaction)
    .createQueryBuilder("t")
    .select(`t.${column}`, "id")
    .addSelect("COUNT(*)", "count")
    .where("t.user_id = :userId", { userId })
    .andWhere("(t.status IS NULL OR t.status <> :void)", {
      void: TransactionStatus.VOID,
    })
    .andWhere(`t.${column} IN (:...ids)`, { ids: asked })
    .groupBy(`t.${column}`)
    .getRawMany<{ id: string; count: string | number }>();
  return new Map(rows.map((row) => [row.id, Number(row.count)]));
}

/** The payee's latest rows, newest first, that its history reads. */
export async function loadPayeeHistory(
  m: EntityManager,
  userId: string,
  payeeId: string,
): Promise<QuickAddPayeeHistory> {
  const repo = m.getRepository(Transaction);
  const base = {
    userId,
    payeeId,
    isTransfer: false,
    status: Not(TransactionStatus.VOID),
  };
  const recent = await repo.find({
    where: base,
    select: { id: true, accountId: true, amount: true },
    order: HISTORY_ORDER,
    take: PAYEE_HISTORY_ROWS,
  });
  const unsplit = await repo.find({
    where: { ...base, isSplit: false },
    select: { id: true, categoryId: true },
    order: HISTORY_ORDER,
    take: PAYEE_HISTORY_ROWS,
  });
  return {
    recent: recent.map((row) => ({
      accountId: row.accountId,
      amount: Number(row.amount),
    })),
    categoryIds: unsplit.map((row) => row.categoryId ?? null),
  };
}

/** The account of the caller's most recently created row among `accountIds`. */
export async function loadMostRecentAccountId(
  m: EntityManager,
  userId: string,
  accountIds: readonly string[],
): Promise<string | null> {
  if (accountIds.length === 0) return null;
  const row = await m.getRepository(Transaction).findOne({
    where: { userId, accountId: In([...accountIds]) },
    select: { id: true, accountId: true },
    order: CREATED_ORDER,
  });
  return row?.accountId ?? null;
}
