import type { Account, DailyAccountBalance } from '@/types/account';
import type { Category } from '@/types/category';
import type { Institution } from '@/types/institution';
import type { Payee } from '@/types/payee';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Tag } from '@/types/tag';
import type {
  MonthlyTotal,
  PaginationInfo,
  SearchInterpretation,
  Transaction,
} from '@/types/transaction';
import type { TransactionSort } from '@/lib/transaction-sort';
import { forgetPageSnapshot, readPageSnapshot, writePageSnapshot } from '@/lib/page-snapshot';

/**
 * What the Transactions page last drew (`page-snapshot.ts`). The reference
 * data is the same whatever the filters; the register is one answer to one
 * request, so it carries the key of that request and is drawn again only
 * under exactly the same filters, order and page.
 */
const STATIC_KEY = 'transactions:static';
const REGISTER_KEY = 'transactions:register';

export interface TransactionsStaticSnapshot {
  accounts: Account[];
  categories: Category[];
  payees: Payee[];
  tags: Tag[];
  institutions: Institution[];
  scheduledTransactions: ScheduledTransaction[];
}

export interface TransactionsRegisterSnapshot {
  /** `registerRequestKey` of the request that produced the rows. */
  key: string;
  transactions: Transaction[];
  pagination: PaginationInfo | null;
  startingBalance: number | undefined;
  startingBalanceWithheld: 'sort' | undefined;
  searchEcho: { search: string; interpretation: SearchInterpretation | undefined } | null;
  rowsSort: TransactionSort;
  dailyBalances: DailyAccountBalance[];
  monthlyTotals: MonthlyTotal[];
}

/**
 * Everything that decides which rows a register read returns: the filters
 * (the calendar's set, which is every filter but the dates), the dates, the
 * order and the page.
 */
export function registerRequestKey(
  filters: object,
  startDate: string,
  endDate: string,
  sort: TransactionSort,
  page: number,
): string {
  return JSON.stringify({ filters, startDate, endDate, sort, page });
}

export function readTransactionsStaticSnapshot(): TransactionsStaticSnapshot | undefined {
  return readPageSnapshot<TransactionsStaticSnapshot>(STATIC_KEY);
}

export function writeTransactionsStaticSnapshot(snapshot: TransactionsStaticSnapshot): void {
  writePageSnapshot(STATIC_KEY, snapshot);
}

export function forgetTransactionsStaticSnapshot(): void {
  forgetPageSnapshot(STATIC_KEY);
}

/**
 * The register's last answer, unless the address asks for one row
 * (`targetTransactionId`): that read resolves its own page, so no earlier
 * answer is the one it would draw.
 */
export function readTransactionsRegisterSnapshot(): TransactionsRegisterSnapshot | undefined {
  if (typeof window === 'undefined') return undefined;
  if (new URLSearchParams(window.location.search).has('targetTransactionId')) return undefined;
  return readPageSnapshot<TransactionsRegisterSnapshot>(REGISTER_KEY);
}

export function writeTransactionsRegisterSnapshot(snapshot: TransactionsRegisterSnapshot): void {
  writePageSnapshot(REGISTER_KEY, snapshot);
}

export function forgetTransactionsRegisterSnapshot(): void {
  forgetPageSnapshot(REGISTER_KEY);
}
