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
import { TopGroupsPanel } from '../shared/TopGroupsPanel';
import type { Account } from '@/types/account';
import {
  EMPTY_BALANCE_FORECAST_STATE,
  projectedBalanceFrom,
  readBalanceForecast,
  type BalanceForecastState,
} from '../shared/balance-forecast-state';
import { BalanceForecastUnavailable } from '@/components/accounts/shared/BalanceForecastUnavailable';
import { useOverdueForecastMarkers } from '@/components/accounts/shared/useOverdueForecastMarkers';
import type { GroupedTotal, MonthlyTotal } from '@/types/transaction';

const logger = createLogger('BankingDetailView');

interface BankingDetailViewProps {
  account: Account;
}

/**
 * Detect year-to-date interest income by category name (an "interest" match),
 * returning both the summed amount and the matched category ids (for a drill-in).
 */
function matchInterestIncome(categories: GroupedTotal[]): {
  amount: number;
  categoryIds: string[];
} {
  const matches = categories.filter(
    (c) => c.name && /interest/i.test(c.name) && Number(c.total) > 0,
  );
  return {
    amount: matches.reduce((sum, c) => sum + Number(c.total), 0),
    categoryIds: matches.map((c) => c.id).filter((id): id is string => !!id),
  };
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

  // The panels summarise the current month; deep links carry the same window so
  // the transaction register shows the matching set.
  const { monthStart, yearStart, today } = useMemo(() => {
    const now = new Date();
    return {
      monthStart: format(startOfMonth(now), 'yyyy-MM-dd'),
      yearStart: `${now.getFullYear()}-01-01`,
      today: format(now, 'yyyy-MM-dd'),
    };
  }, []);
  const monthRangeQuery = `startDate=${monthStart}&endDate=${today}`;

  const [historicalBalances, setHistoricalBalances] = useState<DailyBalancePoint[]>([]);
  // ONE piece of state, because "is the projection withheld" is one decision.
  // Held as two -- points here, gaps there -- each render site re-derived the
  // answer from whichever half it could see, and the two disagreed whenever the
  // server withheld without naming a cause (see `readBalanceForecast`).
  const [forecast, setForecast] = useState<BalanceForecastState>(
    EMPTY_BALANCE_FORECAST_STATE,
  );
  const [moneyIn, setMoneyIn] = useState(0);
  const [moneyOut, setMoneyOut] = useState(0);
  const [monthly, setMonthly] = useState<MonthlyTotal[]>([]);
  const [topCategories, setTopCategories] = useState<GroupedTotal[]>([]);
  const [topPayees, setTopPayees] = useState<GroupedTotal[]>([]);
  const [interestEarnedYtd, setInterestEarnedYtd] = useState(0);
  const [interestCategoryIds, setInterestCategoryIds] = useState<string[]>([]);
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

      const [balances, forecastResponse, summary, monthlyTotals, categories, payees, ytdCategories] =
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
            .getSummary({ basis: 'cash', accountId: account.id, startDate: monthStart, endDate: today })
            .catch(() => null),
          transactionsApi
            .getMonthlyTotals({ basis: 'cash', accountIds: [account.id], startDate: twelveMonthsAgo, endDate: today })
            .catch(() => [] as MonthlyTotal[]),
          transactionsApi
            .getGroupedTotals({ basis: 'cash',
              groupBy: 'category',
              accountIds: [account.id],
              startDate: monthStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
          transactionsApi
            .getGroupedTotals({ basis: 'cash',
              groupBy: 'payee',
              accountIds: [account.id],
              startDate: monthStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
          transactionsApi
            .getGroupedTotals({ basis: 'cash',
              groupBy: 'category',
              accountIds: [account.id],
              startDate: yearStart,
              endDate: today,
            })
            .catch(() => [] as GroupedTotal[]),
        ]);

      if (cancelled) return;
      setHistoricalBalances(balances.map((r) => ({ date: r.date, balance: r.balance })));
      // Read once, by the shared reader that owns the whole withholding rule
      // (issue #1247, and its re-audit: the rule was being applied twice from
      // two different fields).
      setForecast(readBalanceForecast(forecastResponse));
      setMoneyIn(summary?.totalIncome ?? 0);
      setMoneyOut(summary?.totalExpenses ?? 0);
      setMonthly(monthlyTotals);
      setTopCategories(categories);
      setTopPayees(payees);
      const interest = matchInterestIncome(ytdCategories);
      setInterestEarnedYtd(interest.amount);
      setInterestCategoryIds(interest.categoryIds);
      setLoadedForId(account.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  // One chart series: history up to today, then the projected forecast. The
  // forecast's first point is today (== the last history point), so drop it.
  const chartData = useMemo(
    () => [...historicalBalances, ...forecast.points.slice(1)],
    [historicalBalances, forecast.points],
  );

  // The overdue occurrences the projection applies on its first day, marked on the
  // line so that day's drop has a cause (discussion #1784).
  const overdueMarkers = useOverdueForecastMarkers(forecast);

  // Both from the same `withheld`, so the panel and the figure cannot disagree.
  const projectedBalance = projectedBalanceFrom(
    forecast,
    Number(account.currentBalance) || 0,
  );

  // An average over a series with a gap is not the average: it is the mean of
  // the days that happen to be known, presented as the mean of all of them. Fall
  // back to the account's own balance rather than reporting that.
  const knownHistoricalBalances = historicalBalances.filter(
    (p): p is typeof p & { balance: number } => p.balance !== null,
  );
  const averageBalance =
    knownHistoricalBalances.length === historicalBalances.length &&
    knownHistoricalBalances.length > 0
      ? Math.round(
          (knownHistoricalBalances.reduce((sum, p) => sum + p.balance, 0) /
            knownHistoricalBalances.length) *
            100,
        ) / 100
      : Number(account.currentBalance) || 0;

  return (
    <div className="space-y-6">
      <BankingSummaryCards
        account={account}
        projectedBalance={projectedBalance}
        overdue={forecast.overdue}
        moneyIn={moneyIn}
        moneyOut={moneyOut}
        interestEarnedYtd={interestEarnedYtd}
        averageBalance={averageBalance}
        onMoneyInClick={() =>
          router.push(`/transactions?basis=cash&accountId=${account.id}&amountFrom=0.01&${monthRangeQuery}`)
        }
        onMoneyOutClick={() =>
          router.push(`/transactions?basis=cash&accountId=${account.id}&amountTo=-0.01&${monthRangeQuery}`)
        }
        onInterestClick={
          interestCategoryIds.length
            ? () =>
                router.push(
                  `/transactions?basis=cash&accountId=${account.id}&categoryIds=${interestCategoryIds.join(
                    ',',
                  )}&startDate=${yearStart}&endDate=${today}`,
                )
            : undefined
        }
      />

      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('chart.title')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6 space-y-4">
          {/* The history still draws; only the forward line is withheld, so the
              panel sits above it and says which schedule stopped the projection
              and how to fix it (issue #1247). */}
          {!isLoading && (forecast.withheld || forecast.unavailable) && (
            <BalanceForecastUnavailable
              gaps={forecast.gaps}
              reason={forecast.unavailable ? 'requestFailed' : 'withheld'}
            />
          )}
          {!isLoading && chartData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('chart.empty')}</p>
          ) : (
            <BalanceHistoryChart
              data={chartData}
              isLoading={isLoading}
              currencyCode={currency}
              accountName={account.name}
              hideTitle
              markers={overdueMarkers}
              markerSnap="later"
            />
          )}
        </div>
      </section>

      <CashFlowMiniReport monthly={monthly} currencyCode={currency} isLoading={isLoading} />

      <div className="grid gap-6 lg:grid-cols-2">
        <TopGroupsPanel
          title={t('topCategories.title')}
          subtitle={t('summary.thisMonth')}
          emptyLabel={t('topCategories.empty')}
          fallbackLabel={t('uncategorised')}
          totals={topCategories}
          currencyCode={currency}
          isLoading={isLoading}
          selectableWhenUnidentified
          onSelect={(categoryId) =>
            router.push(
              `/transactions?basis=cash&accountId=${account.id}&categoryId=${categoryId ?? 'uncategorized'}&${monthRangeQuery}`,
            )
          }
        />
        <TopGroupsPanel
          title={t('topPayees.title')}
          subtitle={t('summary.thisMonth')}
          emptyLabel={t('topPayees.empty')}
          fallbackLabel={t('uncategorised')}
          totals={topPayees}
          currencyCode={currency}
          isLoading={isLoading}
          // A payee row opens the payee's own page; the account+month-scoped
          // register is one click further, from that page's breakdowns. On a
          // jointly shared account the payee belongs to the OWNER's ledger and
          // has no page in this user's context, so go straight to the register
          // -- which does serve the owner's rows for a joint account.
          onSelect={(payeeId) => {
            if (!payeeId) return;
            router.push(
              account.isJoint
                ? `/transactions?basis=cash&accountId=${account.id}&payeeId=${payeeId}&${monthRangeQuery}`
                : `/payees/${payeeId}`,
            );
          }}
        />
      </div>

      <RecurringChargesPanel accountId={account.id} currencyCode={currency} />
    </div>
  );
}
