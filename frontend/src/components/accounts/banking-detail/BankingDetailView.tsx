'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { format, startOfMonth, subMonths } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { DailyBalancePoint } from '@/lib/balance-history';
import { createLogger } from '@/lib/logger';
import { BalanceHistoryChart } from '@/components/transactions/BalanceHistoryChart';
import { RecurringChargesPanel } from '@/components/accounts/shared/RecurringChargesPanel';
import { BankingSummaryCards } from './BankingSummaryCards';
import { CashFlowMiniReport } from './CashFlowMiniReport';
import { TopGroupsPanel } from './TopGroupsPanel';
import type { Account } from '@/types/account';
import type { GroupedTotal, MonthlyTotal } from '@/types/transaction';

const logger = createLogger('BankingDetailView');

interface BankingDetailViewProps {
  account: Account;
}

/** Detect year-to-date interest income by category name (an "interest" match). */
function sumInterestIncome(categories: GroupedTotal[]): number {
  return categories
    .filter((c) => c.name && /interest/i.test(c.name) && Number(c.total) > 0)
    .reduce((sum, c) => sum + Number(c.total), 0);
}

/**
 * The chequing/savings/cash detail body: key figures (balance, projected
 * balance, money in/out, average balance, interest), balance history, a
 * trailing-12-month cash-flow report, top categories/payees, and recurring
 * charges. Composes existing account-scoped analytics -- no new endpoints.
 */
export function BankingDetailView({ account }: BankingDetailViewProps) {
  const t = useTranslations('accountDetail-banking');
  const router = useRouter();
  const currency = account.currencyCode;

  const [historicalBalances, setHistoricalBalances] = useState<DailyBalancePoint[]>([]);
  const [forecastPoints, setForecastPoints] = useState<DailyBalancePoint[]>([]);
  const [moneyIn, setMoneyIn] = useState(0);
  const [moneyOut, setMoneyOut] = useState(0);
  const [monthly, setMonthly] = useState<MonthlyTotal[]>([]);
  const [topCategories, setTopCategories] = useState<GroupedTotal[]>([]);
  const [topPayees, setTopPayees] = useState<GroupedTotal[]>([]);
  const [interestEarnedYtd, setInterestEarnedYtd] = useState(0);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
      const yearStart = `${now.getFullYear()}-01-01`;
      const twelveMonthsAgo = format(subMonths(now, 11), 'yyyy-MM-dd');

      const [balances, forecast, summary, monthlyTotals, categories, payees, ytdCategories] =
        await Promise.all([
          // Cap history at today so the forecast owns everything after it (the
          // forecast already includes any future-dated real transactions).
          accountsApi
            .getDailyBalances({ accountIds: account.id, endDate: today })
            .catch((error) => {
              logger.error('Failed to load balance history:', error);
              return [] as { date: string; balance: number }[];
            }),
          accountsApi.getBalanceForecast(account.id).catch((error) => {
            logger.error('Failed to load balance forecast:', error);
            return null;
          }),
          transactionsApi
            .getSummary({ accountId: account.id, startDate: monthStart, endDate: today })
            .catch(() => null),
          transactionsApi
            .getMonthlyTotals({ accountIds: [account.id], startDate: twelveMonthsAgo, endDate: today })
            .catch(() => [] as MonthlyTotal[]),
          transactionsApi
            .getGroupedTotals({
              groupBy: 'category',
              accountIds: [account.id],
              startDate: monthStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
          transactionsApi
            .getGroupedTotals({
              groupBy: 'payee',
              accountIds: [account.id],
              startDate: monthStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
          transactionsApi
            .getGroupedTotals({
              groupBy: 'category',
              accountIds: [account.id],
              startDate: yearStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
        ]);

      if (cancelled) return;
      setHistoricalBalances(balances.map((r) => ({ date: r.date, balance: r.balance })));
      setForecastPoints(
        forecast ? forecast.points.map((p) => ({ date: p.date, balance: p.balance })) : [],
      );
      setMoneyIn(summary?.totalIncome ?? 0);
      setMoneyOut(summary?.totalExpenses ?? 0);
      setMonthly(monthlyTotals);
      setTopCategories(categories);
      setTopPayees(payees);
      setInterestEarnedYtd(sumInterestIncome(ytdCategories));
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  // One chart series: history up to today, then the projected forecast. The
  // forecast's first point is today (== the last history point), so drop it.
  const chartData = useMemo(
    () => [...historicalBalances, ...forecastPoints.slice(1)],
    [historicalBalances, forecastPoints],
  );

  // Projected balance is the end of the forecast (falls back to current).
  const projectedBalance = forecastPoints.length
    ? forecastPoints[forecastPoints.length - 1].balance
    : Number(account.currentBalance) || 0;

  const averageBalance = historicalBalances.length
    ? Math.round(
        (historicalBalances.reduce((sum, p) => sum + p.balance, 0) / historicalBalances.length) *
          100,
      ) / 100
    : Number(account.currentBalance) || 0;

  return (
    <div className="space-y-6">
      <BankingSummaryCards
        account={account}
        projectedBalance={projectedBalance}
        moneyIn={moneyIn}
        moneyOut={moneyOut}
        interestEarnedYtd={interestEarnedYtd}
        averageBalance={averageBalance}
      />

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('chart.title')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          {!isLoading && chartData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('chart.empty')}</p>
          ) : (
            <BalanceHistoryChart
              data={chartData}
              isLoading={isLoading}
              currencyCode={currency}
              accountName={account.name}
            />
          )}
        </div>
      </section>

      <CashFlowMiniReport monthly={monthly} currencyCode={currency} isLoading={isLoading} />

      <div className="grid gap-6 lg:grid-cols-2">
        <TopGroupsPanel
          title={t('topCategories.title')}
          emptyLabel={t('topCategories.empty')}
          fallbackLabel={t('uncategorised')}
          totals={topCategories}
          currencyCode={currency}
          isLoading={isLoading}
          onSelect={(categoryId) =>
            router.push(`/transactions?accountId=${account.id}&categoryId=${categoryId}`)
          }
        />
        <TopGroupsPanel
          title={t('topPayees.title')}
          emptyLabel={t('topPayees.empty')}
          fallbackLabel={t('uncategorised')}
          totals={topPayees}
          currencyCode={currency}
          isLoading={isLoading}
          onSelect={(payeeId) =>
            router.push(`/transactions?accountId=${account.id}&payeeId=${payeeId}`)
          }
        />
      </div>

      <RecurringChargesPanel accountId={account.id} currencyCode={currency} />
    </div>
  );
}
