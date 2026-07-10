'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format, startOfMonth } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { DailyBalancePoint } from '@/lib/balance-history';
import { createLogger } from '@/lib/logger';
import { BalanceHistoryChart } from '@/components/transactions/BalanceHistoryChart';
import { CreditCardSummaryCards } from './CreditCardSummaryCards';
import { StatementPanel } from './StatementPanel';
import { SpendingBreakdown } from './SpendingBreakdown';
import { InterestAndFeesPanel } from './InterestAndFeesPanel';
import { RecurringChargesPanel } from '@/components/accounts/shared/RecurringChargesPanel';
import { PayoffCalculator } from './PayoffCalculator';
import type { Account } from '@/types/account';
import type { GroupedTotal } from '@/types/transaction';
import type { StatementCycle, InterestPaid } from '@/types/credit-card-detail';

const logger = createLogger('CreditCardDetailView');

interface CreditCardDetailViewProps {
  account: Account;
}

/**
 * The credit card detail body: key figures, statement cycle, balance history,
 * cycle spending breakdown, recurring charges, YTD interest/fees, and a payoff
 * calculator. Loads its own analytics (the statement cycle is unavailable until
 * a settlement day is configured, in which case the panel shows a hint).
 */
export function CreditCardDetailView({ account }: CreditCardDetailViewProps) {
  const t = useTranslations('accountDetail-creditCard');
  const currency = account.currencyCode;

  const [cycle, setCycle] = useState<StatementCycle | null>(null);
  const [spending, setSpending] = useState<GroupedTotal[]>([]);
  const [interest, setInterest] = useState<InterestPaid | null>(null);
  const [dailyBalances, setDailyBalances] = useState<DailyBalancePoint[]>([]);
  // Deriving loading from the last-resolved id avoids a synchronous setState in
  // the effect (matching LineOfCreditView).
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The statement cycle 400s when no settlement day is set -- treat that as
      // "unavailable" rather than an error.
      const cycleData = await accountsApi.getStatementCycle(account.id).catch(() => null);
      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const spendStart = cycleData ? cycleData.cycleStart : format(startOfMonth(now), 'yyyy-MM-dd');
      const spendEnd = cycleData ? cycleData.cycleEnd : today;
      const yearStart = `${now.getFullYear()}-01-01`;

      const [totalsData, interestData, balancesData] = await Promise.all([
        transactionsApi
          .getGroupedTotals({
            groupBy: 'category',
            accountIds: [account.id],
            startDate: spendStart,
            endDate: spendEnd,
            // Include charges from before the cycle start that have not yet
            // been reconciled -- they usually cleared late but still count
            // toward this cycle's spending.
            includeUnreconciledBeforeStart: true,
          })
          .catch((error) => {
            logger.error('Failed to load spending breakdown:', error);
            return [] as GroupedTotal[];
          }),
        accountsApi.getInterestPaid(account.id, yearStart, today).catch(() => null),
        accountsApi.getDailyBalances({ accountIds: account.id }).catch((error) => {
          logger.error('Failed to load balance history:', error);
          return [] as { date: string; balance: number }[];
        }),
      ]);

      if (cancelled) return;
      setCycle(cycleData);
      setSpending(totalsData);
      setInterest(interestData);
      setDailyBalances(balancesData.map((r) => ({ date: r.date, balance: r.balance })));
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  return (
    <div className="space-y-6">
      <CreditCardSummaryCards account={account} />

      <StatementPanel cycle={cycle} isLoading={isLoading} />

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('chart.title')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          {!isLoading && dailyBalances.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('chart.empty')}</p>
          ) : (
            <BalanceHistoryChart
              data={dailyBalances}
              isLoading={isLoading}
              currencyCode={currency}
              accountName={account.name}
            />
          )}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SpendingBreakdown totals={spending} currencyCode={currency} isLoading={isLoading} />
        <RecurringChargesPanel accountId={account.id} currencyCode={currency} />
        <InterestAndFeesPanel interest={interest} currencyCode={currency} isLoading={isLoading} />
      </div>

      <PayoffCalculator
        balance={Math.abs(Number(account.currentBalance) || 0)}
        interestRate={account.interestRate}
        currencyCode={currency}
      />
    </div>
  );
}
