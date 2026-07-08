'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { accountsApi } from '@/lib/accounts';
import { DailyBalancePoint, computeBalanceSummary } from '@/lib/balance-history';
import { utilizationColour } from '@/lib/credit-utilization';
import { BalanceHistoryChart } from '@/components/transactions/BalanceHistoryChart';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import type { Account } from '@/types/account';

const logger = createLogger('LineOfCreditView');

interface LineOfCreditViewProps {
  account: Account;
}

/**
 * Revolving-credit view for a line of credit. Unlike an amortizing loan it has
 * no fixed origination principal or payoff, so it shows the true balance
 * history (draws and repayments both counted, anchored to the real opening
 * balance) plus credit-limit utilization -- not an amortization schedule.
 */
export function LineOfCreditView({ account }: LineOfCreditViewProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const currency = account.currencyCode;

  const [dailyBalances, setDailyBalances] = useState<DailyBalancePoint[]>([]);
  // The load is "done" for whichever account id we last resolved; deriving
  // loading from that avoids a synchronous setState inside the effect.
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const isLoading = loadedForId !== account.id;

  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getDailyBalances({ accountIds: account.id })
      .then((rows) => {
        if (!cancelled) {
          setDailyBalances(rows.map((r) => ({ date: r.date, balance: r.balance })));
          setLoadedForId(account.id);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error('Failed to load balance history:', error);
        setDailyBalances([]);
        setLoadedForId(account.id);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  const used = Math.abs(Number(account.currentBalance) || 0);
  const limit = Number(account.creditLimit) || 0;
  const hasLimit = limit > 0;
  const available = Math.max(0, limit - used);
  const utilizationPercent = hasLimit ? (used / limit) * 100 : 0;

  const summary = useMemo(() => computeBalanceSummary(dailyBalances), [dailyBalances]);
  const peakBalance = summary ? Math.abs(Math.min(0, summary.minBalance)) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          label={t('loanDetail.lineOfCredit.currentBalance')}
          value={formatCurrency(used, currency)}
          valueClass="text-red-600 dark:text-red-400"
        />
        {hasLimit ? (
          <>
            <SummaryCard
              label={t('loanDetail.lineOfCredit.creditLimit')}
              value={formatCurrency(limit, currency)}
            />
            <SummaryCard
              label={t('loanDetail.lineOfCredit.available')}
              value={formatCurrency(available, currency)}
              valueClass="text-green-600 dark:text-green-400"
            />
          </>
        ) : (
          <SummaryCard
            label={t('loanDetail.lineOfCredit.peakBalance')}
            value={formatCurrency(peakBalance, currency)}
          />
        )}
        {hasLimit && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t('loanDetail.lineOfCredit.utilization')}
            </div>
            <div className="text-lg font-bold" style={{ color: utilizationColour(utilizationPercent) }}>
              {utilizationPercent.toFixed(1)}%
            </div>
            <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, utilizationPercent)}%`,
                  backgroundColor: utilizationColour(utilizationPercent),
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 px-4 sm:px-0">
          {t('loanDetail.lineOfCredit.balanceHistory')}
        </h3>
        {!isLoading && dailyBalances.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('loanDetail.lineOfCredit.noHistory')}
          </p>
        ) : (
          <BalanceHistoryChart
            data={dailyBalances}
            isLoading={isLoading}
            currencyCode={currency}
            accountName={account.name}
          />
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  valueClass = 'text-gray-900 dark:text-gray-100',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
