'use client';

import { ReportStatement, useReportStatement } from '@/components/reports/variants/ReportStatement';
import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { IncomeExpenseTagBucket } from '@/types/built-in-reports';
import type { TaggedBalanceWindow } from '@/lib/tagged-balance';
import type { ConvertedTotal } from '@/lib/currency-total';

interface CashFlowSummaryCardsProps {
  /**
   * The three Net Cash Flow figures, each marked as a subtotal when a row could
   * not be converted; null when there is no response (no figures, not zeros).
   */
  totals: { income: ConvertedTotal; expenses: ConvertedTotal; net: ConvertedTotal } | null;
  reportingCurrency: string;
  /**
   * The Balance view (spec section 10.9): the part of the All totals that
   * converted, the All completeness, the active tag bucket and the window's
   * Balance. Absent = the three Net Cash Flow cards exactly as before.
   */
  balance?: {
    bucket: IncomeExpenseTagBucket;
    window: TaggedBalanceWindow;
    knownIncome: number;
    knownExpenses: number;
    completeness: { missingCurrencies: string[]; excludedCount: number };
  };
}

interface Tone {
  box: string;
  label: string;
  value: string;
}

const GREEN: Tone = {
  box: 'bg-green-50 dark:bg-green-900/20',
  label: 'text-green-600 dark:text-green-400',
  value: 'text-green-700 dark:text-green-300',
};
const RED: Tone = {
  box: 'bg-red-50 dark:bg-red-900/20',
  label: 'text-red-600 dark:text-red-400',
  value: 'text-red-700 dark:text-red-300',
};
const INDIGO: Tone = {
  box: 'bg-indigo-50 dark:bg-indigo-900/20',
  label: 'text-indigo-600 dark:text-indigo-400',
  value: 'text-indigo-700 dark:text-indigo-300',
};
const BLUE: Tone = {
  box: 'bg-blue-50 dark:bg-blue-900/20',
  label: 'text-blue-600 dark:text-blue-400',
  value: 'text-blue-700 dark:text-blue-300',
};
const PURPLE: Tone = {
  box: 'bg-purple-50 dark:bg-purple-900/20',
  label: 'text-purple-600 dark:text-purple-400',
  value: 'text-purple-700 dark:text-purple-300',
};
const ORANGE: Tone = {
  box: 'bg-orange-50 dark:bg-orange-900/20',
  label: 'text-orange-600 dark:text-orange-400',
  value: 'text-orange-700 dark:text-orange-300',
};

function SummaryCard({ tone, label, children }: { tone: Tone; label: string; children: React.ReactNode }) {
  return (
    <div className={`ui-rep-tile rounded-lg p-4 sm:p-6 ${tone.box}`}>
      <div className={`text-sm ${tone.label}`}>{label}</div>
      <div className={`text-2xl font-bold ${tone.value}`}>{children}</div>
    </div>
  );
}

export function CashFlowSummaryCards({ totals, reportingCurrency, balance }: CashFlowSummaryCardsProps) {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();
  const asStatement = useReportStatement();

  if (balance) {
    const { bucket, window: win, knownIncome, knownExpenses, completeness } = balance;
    const bucketCompleteness = {
      missingCurrencies: bucket.missingCurrencies,
      excludedCount: bucket.excludedCount,
    };
    const known = win.balance ?? 0;
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard tone={GREEN} label={t('cashFlow.totalInflows')}>
          <PartialTotal total={{ value: knownIncome, ...completeness }} displayCurrency={reportingCurrency}>
            {formatCurrency(knownIncome)}
          </PartialTotal>
        </SummaryCard>
        <SummaryCard tone={INDIGO} label={t('tagBreakdown.inflows')}>
          <PartialTotal total={{ value: bucket.taggedInflows, ...bucketCompleteness }} displayCurrency={reportingCurrency}>
            {formatCurrency(bucket.taggedInflows)}
          </PartialTotal>
        </SummaryCard>
        <SummaryCard tone={RED} label={t('cashFlow.totalOutflows')}>
          <PartialTotal total={{ value: knownExpenses, ...completeness }} displayCurrency={reportingCurrency}>
            {formatCurrency(knownExpenses)}
          </PartialTotal>
        </SummaryCard>
        {bucket.taggedOutflows !== 0 && (
          <SummaryCard tone={INDIGO} label={t('tagBreakdown.outflows')}>
            <PartialTotal total={{ value: bucket.taggedOutflows, ...bucketCompleteness }} displayCurrency={reportingCurrency}>
              {formatCurrency(bucket.taggedOutflows)}
            </PartialTotal>
          </SummaryCard>
        )}
        <SummaryCard tone={known >= 0 ? BLUE : ORANGE} label={t('tagBreakdown.balance')}>
          <PartialTotal
            total={{ value: known, missingCurrencies: win.missingCurrencies, excludedCount: win.excludedCount }}
            displayCurrency={reportingCurrency}
          >
            {formatCurrency(known)}
          </PartialTotal>
        </SummaryCard>
        <SummaryCard
          tone={win.balancePercent !== null && win.balancePercent < 0 ? ORANGE : PURPLE}
          label={t('tagBreakdown.balancePercent')}
        >
          {win.balancePercent === null ? '—' : formatPercent(win.balancePercent, 2)}
        </SummaryCard>
      </div>
    );
  }

  // No figures is neither a gain nor a loss; it takes the neutral colour.
  const netIsNonNegative = totals === null || totals.net.value >= 0;
  if (asStatement) {
    const figure = (total: ConvertedTotal | undefined, prefix = '') =>
      total ? (
        <PartialTotal total={total} displayCurrency={reportingCurrency}>
          {prefix}
          {formatCurrency(total.value)}
        </PartialTotal>
      ) : (
        t('cashFlow.notAvailable')
      );
    return (
      <ReportStatement
        ariaLabel={t('cashFlow.netCashFlow')}
        lines={[
          { key: 'in', label: t('cashFlow.totalInflows'), value: figure(totals?.income), tone: 'gain' },
          { key: 'out', label: t('cashFlow.totalOutflows'), value: figure(totals?.expenses), tone: 'loss' },
        ]}
        total={{
          label: t('cashFlow.netCashFlow'),
          value: figure(totals?.net, netIsNonNegative ? '+' : ''),
          tone: netIsNonNegative ? 'plain' : 'loss',
        }}
      />
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <SummaryCard tone={GREEN} label={t('cashFlow.totalInflows')}>
        {totals ? (
          <PartialTotal total={totals.income} displayCurrency={reportingCurrency}>
            {formatCurrency(totals.income.value)}
          </PartialTotal>
        ) : (
          t('cashFlow.notAvailable')
        )}
      </SummaryCard>
      <SummaryCard tone={RED} label={t('cashFlow.totalOutflows')}>
        {totals ? (
          <PartialTotal total={totals.expenses} displayCurrency={reportingCurrency}>
            {formatCurrency(totals.expenses.value)}
          </PartialTotal>
        ) : (
          t('cashFlow.notAvailable')
        )}
      </SummaryCard>
      <SummaryCard tone={netIsNonNegative ? BLUE : ORANGE} label={t('cashFlow.netCashFlow')}>
        {totals ? (
          <PartialTotal total={totals.net} displayCurrency={reportingCurrency}>
            {netIsNonNegative ? '+' : ''}
            {formatCurrency(totals.net.value)}
          </PartialTotal>
        ) : (
          t('cashFlow.notAvailable')
        )}
      </SummaryCard>
    </div>
  );
}
