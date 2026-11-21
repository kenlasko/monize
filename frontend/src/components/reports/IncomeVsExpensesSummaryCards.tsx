'use client';

import { ReportStatement, useReportStatement } from '@/components/reports/variants/ReportStatement';
import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { IncomeExpenseTagBucket } from '@/types/built-in-reports';
import type { TaggedBalanceWindow } from '@/lib/tagged-balance';

export interface IncomeVsExpensesTotals {
  totalIncome: number;
  totalExpenses: number;
  totalSavings: number;
  savingsRate: number;
}

interface IncomeVsExpensesSummaryCardsProps {
  totals: IncomeVsExpensesTotals;
  completeness: { missingCurrencies: string[]; excludedCount: number };
  reportingCurrency: string;
  /**
   * The Balance view (section 10.9 of the spec): the active tag bucket and the
   * window's Balance. Absent = the Savings cards exactly as before.
   */
  balance?: { bucket: IncomeExpenseTagBucket; window: TaggedBalanceWindow };
}

const POSITIVE_BLUE = {
  box: 'bg-blue-50 dark:bg-blue-900/20',
  label: 'text-blue-600 dark:text-blue-400',
  value: 'text-blue-700 dark:text-blue-300',
};
const POSITIVE_PURPLE = {
  box: 'bg-purple-50 dark:bg-purple-900/20',
  label: 'text-purple-600 dark:text-purple-400',
  value: 'text-purple-700 dark:text-purple-300',
};
const NEGATIVE = {
  box: 'bg-orange-50 dark:bg-orange-900/20',
  label: 'text-orange-600 dark:text-orange-400',
  value: 'text-orange-700 dark:text-orange-300',
};
const INDIGO = {
  box: 'bg-indigo-50 dark:bg-indigo-900/20',
  label: 'text-indigo-600 dark:text-indigo-400',
  value: 'text-indigo-700 dark:text-indigo-300',
};
const GREEN = {
  box: 'bg-green-50 dark:bg-green-900/20',
  label: 'text-green-600 dark:text-green-400',
  value: 'text-green-700 dark:text-green-300',
};
const RED = {
  box: 'bg-red-50 dark:bg-red-900/20',
  label: 'text-red-600 dark:text-red-400',
  value: 'text-red-700 dark:text-red-300',
};

interface SummaryCardProps {
  tone: { box: string; label: string; value: string };
  label: string;
  children: React.ReactNode;
}

function SummaryCard({ tone, label, children }: SummaryCardProps) {
  return (
    <div className={`ui-rep-tile rounded-lg p-4 text-center ${tone.box}`}>
      <div className={`text-sm ${tone.label}`}>{label}</div>
      <div className={`text-xl font-bold ${tone.value}`}>{children}</div>
    </div>
  );
}

export function IncomeVsExpensesSummaryCards({
  totals,
  completeness,
  reportingCurrency,
  balance,
}: IncomeVsExpensesSummaryCardsProps) {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();
  const asStatement = useReportStatement();

  const income = (
    <SummaryCard tone={GREEN} label={t('incomeVsExpenses.totalIncome')}>
      <PartialTotal total={{ value: totals.totalIncome, ...completeness }} displayCurrency={reportingCurrency}>
        {formatCurrency(totals.totalIncome)}
      </PartialTotal>
    </SummaryCard>
  );
  const expenses = (
    <SummaryCard tone={RED} label={t('incomeVsExpenses.totalExpenses')}>
      <PartialTotal total={{ value: totals.totalExpenses, ...completeness }} displayCurrency={reportingCurrency}>
        {formatCurrency(totals.totalExpenses)}
      </PartialTotal>
    </SummaryCard>
  );

  if (balance) {
    const { bucket, window: win } = balance;
    const bucketCompleteness = {
      missingCurrencies: bucket.missingCurrencies,
      excludedCount: bucket.excludedCount,
    };
    const flow = (value: number) => (
      <PartialTotal total={{ value, ...bucketCompleteness }} displayCurrency={reportingCurrency}>
        {formatCurrency(value)}
      </PartialTotal>
    );
    const known = win.balance ?? 0;
    const tone = known >= 0 ? POSITIVE_BLUE : NEGATIVE;
    const pctTone = win.balancePercent !== null && win.balancePercent < 0 ? NEGATIVE : POSITIVE_PURPLE;
    return (
      <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-3 gap-4">
        {income}
        <SummaryCard tone={INDIGO} label={t('tagBreakdown.inflows')}>{flow(bucket.taggedInflows)}</SummaryCard>
        {expenses}
        {bucket.taggedOutflows !== 0 && (
          <SummaryCard tone={INDIGO} label={t('tagBreakdown.outflows')}>{flow(bucket.taggedOutflows)}</SummaryCard>
        )}
        <SummaryCard tone={tone} label={t('tagBreakdown.balance')}>
          <PartialTotal
            total={{ value: known, missingCurrencies: win.missingCurrencies, excludedCount: win.excludedCount }}
            displayCurrency={reportingCurrency}
          >
            {formatCurrency(known)}
          </PartialTotal>
        </SummaryCard>
        <SummaryCard tone={pctTone} label={t('tagBreakdown.balancePercent')}>
          {win.balancePercent === null ? '—' : formatPercent(win.balancePercent, 2)}
        </SummaryCard>
      </div>
    );
  }

  if (asStatement) {
    const partial = (value: number) => (
      <PartialTotal total={{ value, ...completeness }} displayCurrency={reportingCurrency}>
        {formatCurrency(value)}
      </PartialTotal>
    );
    return (
      <div className="mt-6">
        <ReportStatement
          ariaLabel={t('page.names.income-vs-expenses')}
          lines={[
            { key: 'income', label: t('incomeVsExpenses.totalIncome'), value: partial(totals.totalIncome), tone: 'gain' },
            { key: 'expenses', label: t('incomeVsExpenses.totalExpenses'), value: partial(totals.totalExpenses), tone: 'loss' },
          ]}
          total={{
            label: t('incomeVsExpenses.totalSavings'),
            value: partial(totals.totalSavings),
            tone: totals.totalSavings >= 0 ? 'plain' : 'loss',
          }}
          memo={[
            {
              key: 'rate',
              label: t('incomeVsExpenses.savingsRate'),
              value: formatPercent(totals.savingsRate, 1),
              tone: totals.savingsRate >= 0 ? 'plain' : 'loss',
            },
          ]}
        />
      </div>
    );
  }

  const savingsTone = totals.totalSavings >= 0 ? POSITIVE_BLUE : NEGATIVE;
  const rateTone = totals.savingsRate >= 0 ? POSITIVE_PURPLE : NEGATIVE;
  return (
    <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4">
      {income}
      {expenses}
      <SummaryCard tone={savingsTone} label={t('incomeVsExpenses.totalSavings')}>
        <PartialTotal total={{ value: totals.totalSavings, ...completeness }} displayCurrency={reportingCurrency}>
          {formatCurrency(totals.totalSavings)}
        </PartialTotal>
      </SummaryCard>
      <SummaryCard tone={rateTone} label={t('incomeVsExpenses.savingsRate')}>
        {formatPercent(totals.savingsRate, 1)}
      </SummaryCard>
    </div>
  );
}
