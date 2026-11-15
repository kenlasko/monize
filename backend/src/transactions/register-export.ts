import { PAGINATION_MAX_LIMIT } from "../common/dto/pagination-query.dto";
import {
  maskTransactionsAgainst,
  payloadHasCrossOwnerTransfer,
} from "../delegation/transfer-mask.util";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import type { PaginatedTransactions } from "./transactions.service";

interface NamedRef {
  name: string;
}

/**
 * One register row as the Transactions page's CSV export reads it: only the
 * columns the file is built from, so a whole filtered register fits in one
 * response. A full row carries every eager relation (the account entity with
 * its balance, the linked leg and its account), which for a ledger of tens of
 * thousands of rows is far larger than the file it becomes.
 *
 * The field names and nesting are the full row's, so the client builds the
 * file from either shape with the same code.
 */
export interface TransactionExportRow {
  id: string;
  transactionDate: string;
  /** The stored NUMERIC, serialized as the full row serializes it. */
  amount: number;
  currencyCode: string;
  status: TransactionStatus;
  description: string | null;
  payeeName: string | null;
  isSplit: boolean;
  isTransfer: boolean;
  account: NamedRef | null;
  payee: NamedRef | null;
  category: NamedRef | null;
  tags: NamedRef[];
  linkedTransaction: { account: NamedRef | null } | null;
  splits: {
    amount: number;
    category: NamedRef | null;
    transferAccount: NamedRef | null;
  }[];
}

function namedRef(
  entity: { name: string } | null | undefined,
): NamedRef | null {
  return entity ? { name: entity.name } : null;
}

export function toTransactionExportRow(tx: Transaction): TransactionExportRow {
  return {
    id: tx.id,
    transactionDate: tx.transactionDate,
    amount: tx.amount,
    currencyCode: tx.currencyCode,
    status: tx.status,
    description: tx.description ?? null,
    payeeName: tx.payeeName ?? null,
    isSplit: tx.isSplit,
    isTransfer: tx.isTransfer,
    account: namedRef(tx.account),
    payee: namedRef(tx.payee),
    category: namedRef(tx.category),
    tags: (tx.tags ?? []).map((tag) => ({ name: tag.name })),
    linkedTransaction: tx.linkedTransaction
      ? { account: namedRef(tx.linkedTransaction.account) }
      : null,
    splits: (tx.splits ?? []).map((split) => ({
      amount: split.amount,
      category: namedRef(split.category),
      transferAccount: namedRef(split.transferAccount),
    })),
  };
}

/**
 * Every row of a filtered register, walked page by page on the server.
 *
 * The Transactions page used to walk `GET /transactions` itself, 50 rows a
 * request, so a 26,000-row ledger took 520 requests and ran into the global
 * 100-a-minute throttle (issue #2198). Walking here makes an export one
 * request, the way the account export already is, while every page is still
 * the register's own query: the filters, the delegate and joint scope and the
 * order are the ones the register shows.
 *
 * The projection drops the fields the transfer mask keys on, so the mask runs
 * here, on the full rows, before projecting: the HTTP interceptor would find
 * nothing left to mask. The readable set is fetched at most once.
 */
export async function collectRegisterExportRows(deps: {
  fetchPage: (page: number, limit: number) => Promise<PaginatedTransactions>;
  readableAccountIds: () => Promise<Set<string>>;
  isActing: boolean;
}): Promise<TransactionExportRow[]> {
  const rows: TransactionExportRow[] = [];
  let readable: Set<string> | undefined;
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const result = await deps.fetchPage(page, PAGINATION_MAX_LIMIT);
    // A page with no rows has nothing after it, whatever hasMore says.
    if (result.data.length === 0) break;
    if (deps.isActing || payloadHasCrossOwnerTransfer(result.data)) {
      readable ??= await deps.readableAccountIds();
      maskTransactionsAgainst(readable, result.data);
    }
    rows.push(...result.data.map(toTransactionExportRow));
    hasMore = result.pagination.hasMore;
    page++;
  }
  return rows;
}
