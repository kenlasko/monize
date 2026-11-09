'use client';

import { useEffect, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { customReportsApi } from '@/lib/custom-reports';
import { helpApi, type HelpSearchAnswer } from '@/lib/help';
import { useHelpPrefetch } from '@/lib/help-open';
import { investmentReportsApi } from '@/lib/investment-reports';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import { payeesApi } from '@/lib/payees';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { transactionsApi } from '@/lib/transactions';
import { useHelpStore } from '@/store/helpStore';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { CustomReport } from '@/types/custom-report';
import type { InvestmentReport } from '@/types/investment-report';
import type { Security } from '@/types/investment';
import type { Payee } from '@/types/payee';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Transaction } from '@/types/transaction';

const logger = createLogger('CommandPalette');

export const COMMAND_SEARCH_DEBOUNCE_MS = 150;
/** A single letter matches most of a register; the server is not asked. */
const MIN_REMOTE_QUERY_LENGTH = 2;
const REMOTE_RESULT_LIMIT = 5;

export interface CommandData {
  accounts: Account[];
  payees: Payee[];
  categories: Category[];
  bills: ScheduledTransaction[];
  securities: Security[];
  customReports: CustomReport[];
  investmentReports: InvestmentReport[];
}

const EMPTY_DATA: CommandData = {
  accounts: [],
  payees: [],
  categories: [],
  bills: [],
  securities: [],
  customReports: [],
  investmentReports: [],
};

/** A delegate's refused section is not a failure; it just has nothing to list. */
function isForbidden(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 403;
}

/**
 * Everything the palette filters locally, loaded once when it opens. A source
 * is read only when its route is `reachable` for this session, and one that
 * fails leaves its group empty without taking the others with it.
 */
export function useCommandPaletteData(reachable: ReadonlySet<string>) {
  const [state, setState] = useState({ data: EMPTY_DATA, loading: true, failed: false });
  const reachableKey = [...reachable].sort().join();

  useEffect(() => {
    let cancelled = false;
    let anyFailed = false;
    const can = (route: string) => reachableKey.split(',').includes(route);
    const read = async <T,>(enabled: boolean, load: () => Promise<T[]>): Promise<T[]> => {
      if (!enabled) return [];
      try {
        return await load();
      } catch (error) {
        if (!isForbidden(error)) {
          anyFailed = true;
          logger.error(error);
        }
        return [];
      }
    };

    void Promise.all([
      read(can('/accounts'), () => accountsApi.getAll()),
      read(can('/payees'), () => payeesApi.getAll()),
      read(can('/categories'), () => categoriesApi.getAll()),
      read(can('/bills'), () => scheduledTransactionsApi.getAll()),
      read(can('/securities'), () => investmentsApi.getSecurities()),
      read(can('/reports'), () => customReportsApi.getAll()),
      read(can('/reports'), () => investmentReportsApi.getAll()),
    ]).then(([accounts, payees, categories, bills, securities, customReports, investmentReports]) => {
      if (cancelled) return;
      setState({
        data: { accounts, payees, categories, bills, securities, customReports, investmentReports },
        loading: false,
        failed: anyFailed,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [reachableKey]);

  return state;
}

/** What one query answered; a `null` list is a request that failed. */
interface RemoteAnswer {
  key: string;
  transactions: Transaction[] | null;
  help: HelpSearchAnswer['results'] | null;
}

/**
 * The two searches only the server can answer, debounced. An answer is kept
 * with the query that produced it, so a slow response to an abandoned query
 * never draws under a newer one.
 *
 * A help failure is reported only once the guide is known to be bundled: a
 * server without it refuses every search, which is not an outage.
 */
export function useCommandPaletteSearch(query: string, canSearchTransactions: boolean) {
  const contextPage = useHelpStore((s) => s.contextPage);
  const guideAvailable = useHelpStore((s) => s.guideAvailable);
  useHelpPrefetch();
  const rested = useDebouncedValue(query, COMMAND_SEARCH_DEBOUNCE_MS);
  const [answer, setAnswer] = useState<RemoteAnswer | null>(null);

  useEffect(() => {
    if (rested.length < MIN_REMOTE_QUERY_LENGTH) return;
    let cancelled = false;
    void Promise.allSettled([
      canSearchTransactions
        ? transactionsApi.getAll({ search: rested, limit: REMOTE_RESULT_LIMIT }).then((page) => page.data)
        : Promise.resolve<Transaction[]>([]),
      helpApi.search(rested, { context: contextPage ?? undefined, limit: REMOTE_RESULT_LIMIT }),
    ]).then(([transactions, help]) => {
      if (cancelled) return;
      if (transactions.status === 'rejected') logger.error(transactions.reason);
      setAnswer({
        key: rested,
        transactions: transactions.status === 'fulfilled' ? transactions.value : null,
        help: help.status === 'fulfilled' ? help.value.results : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rested, canSearchTransactions, contextPage]);

  const current = answer?.key === query ? answer : null;
  return {
    transactions: current?.transactions ?? [],
    help: current?.help ?? [],
    pending: query.length >= MIN_REMOTE_QUERY_LENGTH && current === null,
    failed:
      current !== null &&
      (current.transactions === null || (current.help === null && guideAvailable === true)),
  };
}
