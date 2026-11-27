'use client';

import { isIncomeCategory as isIncomeCategoryType } from '@/lib/category-type';
import { useTranslations } from 'next-intl';
import { gainLossColor, roundMoney, sumMoney } from '@/lib/format';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { BudgetProgressBar } from './BudgetProgressBar';
import { budgetLineName } from './utils/budget-line-name';
import { Card, CARD_CLASS } from '@/components/ui/Card';
import { TABLE_CLASS, TABLE_BODY_CLASS, Th, Td } from '@/components/ui/Table';
import type { BudgetPeriod, BudgetPeriodCategory } from '@/types/budget';

import { useNumberFormat } from '@/hooks/useNumberFormat';
interface BudgetPeriodDetailProps {
  period: BudgetPeriod;
  formatCurrency: (amount: number) => string;
}

function getCategoryName(
  pc: BudgetPeriodCategory,
  labels: { transfersFrom: (name: string) => string; unknown: string },
): string {
  if (pc.budgetCategory?.isTransfer && pc.budgetCategory.transferAccount) {
    return budgetLineName(pc.budgetCategory, labels);
  }
  if (pc.category?.name) return pc.category.name;
  if (pc.budgetCategory?.category?.name) return pc.budgetCategory.category.name;
  return 'Uncategorized';
}

function isIncomeCategory(pc: BudgetPeriodCategory): boolean {
  if (pc.budgetCategory?.isIncome) return true;
  if (pc.category && isIncomeCategoryType(pc.category)) return true;
  return false;
}

export function BudgetPeriodDetail({
  period,
  formatCurrency,
}: BudgetPeriodDetailProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const periodBuckets = period.periodBuckets ?? [];
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  const categories = period.periodCategories ?? [];
  const expenseCategories = categories.filter((pc) => !isIncomeCategory(pc));
  const incomeCategories = categories.filter((pc) => isIncomeCategory(pc));

  const totalBudgeted = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.effectiveBudget),
    0,
  );
  const totalSpent = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.actualAmount),
    0,
  );
  const lineIncome = sumMoney(
    incomeCategories.map((pc) => Number(pc.actualAmount)),
  );
  // A closed period's income is the figure the close froze, which includes
  // transfers in no line carries (`transfersInAsIncome`, issue #2141). That
  // part is shown as its own row so the income rows add up to the card. An
  // open period has no frozen figure: its rows are the lines' alone, and the
  // live total, toggle included, is on the budget's dashboard.
  const isClosed = period.status === 'CLOSED';
  const totalIncome = isClosed ? Number(period.actualIncome) : lineIncome;
  const outsideTransferIncome = isClosed
    ? Math.max(0, roundMoney(totalIncome - lineIncome))
    : 0;
  const remaining = totalBudgeted - totalSpent;
  const percentUsed = totalBudgeted > 0
    ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
    : 0;
  const hasRollover = expenseCategories.some(
    (pc) => Number(pc.rolloverIn) !== 0 || Number(pc.rolloverOut) !== 0,
  );
  const totalRolloverIn = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.rolloverIn),
    0,
  );
  const totalRolloverOut = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.rolloverOut),
    0,
  );

  // The month heading in the reader's language and the range in their own
  // date format, never a fixed English pattern.
  const periodLabel = formatChartDate(period.periodStart, 'MMMM yyyy');

  return (
    <div className="space-y-6">
      {/* Period Header */}
      <div className={`${CARD_CLASS} p-6`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {periodLabel}
          </h2>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
            {period.status}
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('periodDetail.dateRange', {
            start: formatDate(period.periodStart),
            end: formatDate(period.periodEnd),
          })}
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label={t('periodDetail.summaryCards.totalBudgeted')}
          value={formatCurrency(totalBudgeted)}
          sublabel={t('periodDetail.categorySublabel', { count: expenseCategories.length })}
        />
        <SummaryCard
          label={t('periodDetail.summaryCards.totalSpent')}
          value={formatCurrency(totalSpent)}
          sublabel={formatPercentTrimmed(percentUsed)}
          valueColor={percentUsed > 100 ? 'text-red-600 dark:text-red-400' : undefined}
        />
        <SummaryCard
          label={remaining >= 0 ? t('periodDetail.summaryCards.underBudget') : t('periodDetail.summaryCards.overBudget')}
          value={formatCurrency(Math.abs(remaining))}
          sublabel={remaining >= 0 ? t('periodDetail.summaryCards.saved') : t('periodDetail.summaryCards.overspent')}
          valueColor={
            gainLossColor(remaining)
          }
        />
        <SummaryCard
          label={t('periodDetail.summaryCards.income')}
          value={formatCurrency(totalIncome)}
          sublabel={totalIncome > 0 ? t('periodDetail.summaryCards.savings', { amount: formatCurrency(totalIncome - totalSpent) }) : undefined}
        />
      </div>

      {/* Rollover Summary */}
      {hasRollover && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
            {t('periodDetail.rolloverSummary.title')}
          </h3>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-blue-600 dark:text-blue-300">{t('periodDetail.rolloverSummary.carriedIn')} </span>
              <span className="font-medium text-blue-900 dark:text-blue-100">
                {formatCurrency(totalRolloverIn)}
              </span>
            </div>
            <div>
              <span className="text-blue-600 dark:text-blue-300">{t('periodDetail.rolloverSummary.carriedOut')} </span>
              <span className="font-medium text-blue-900 dark:text-blue-100">
                {formatCurrency(totalRolloverOut)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Overall Progress */}
      <div className={`${CARD_CLASS} p-6`}>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('periodDetail.overallUsage')}
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(totalSpent)} / {formatCurrency(totalBudgeted)}
          </span>
        </div>
        <BudgetProgressBar percentUsed={percentUsed} />
      </div>

      {/* Buckets: the figures frozen when the period closed */}
      {period.status === 'CLOSED' && periodBuckets.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {t('periodBuckets.title')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th>{t('periodBuckets.name')}</Th>
                  <Th>{t('periodBuckets.target')}</Th>
                  <Th align="right">{t('periodBuckets.allocated')}</Th>
                  <Th align="right">{t('periodBuckets.carriedIn')}</Th>
                  <Th align="right">{t('periodBuckets.spent')}</Th>
                  <Th align="right">{t('periodBuckets.carriedOut')}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {periodBuckets.map((pb) => (
                  <tr key={pb.id}>
                    <Td>{pb.bucketName}</Td>
                    <Td>
                      {pb.targetType === 'PERCENT'
                        ? t('periodBuckets.targetPercent', {
                            percent: formatPercentTrimmed(Number(pb.targetValue)),
                          })
                        : t('periodBuckets.targetAmount', {
                            amount: formatCurrency(Number(pb.targetValue)),
                          })}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {pb.allocatedAmount === null
                        ? t('periodBuckets.allocatedUnknown')
                        : formatCurrency(Number(pb.allocatedAmount))}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatCurrency(Number(pb.carryIn))}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatCurrency(Number(pb.actualAmount))}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatCurrency(Number(pb.carryOut))}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Expense Categories */}
      {expenseCategories.length > 0 && (
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {t('periodDetail.expenseCategories')}
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {[...expenseCategories]
              .sort((a, b) => {
                const pctA = Number(a.effectiveBudget) > 0
                  ? Number(a.actualAmount) / Number(a.effectiveBudget)
                  : 0;
                const pctB = Number(b.effectiveBudget) > 0
                  ? Number(b.actualAmount) / Number(b.effectiveBudget)
                  : 0;
                return pctB - pctA;
              })
              .map((pc) => (
                <PeriodCategoryRow
                  key={pc.id}
                  periodCategory={pc}
                  formatCurrency={formatCurrency}
                />
              ))}
          </div>
        </div>
      )}

      {/* Income Categories */}
      {(incomeCategories.length > 0 || outsideTransferIncome > 0) && (
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              {t('periodDetail.incomeCategories')}
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {incomeCategories.map((pc) => (
              <PeriodCategoryRow
                key={pc.id}
                periodCategory={pc}
                formatCurrency={formatCurrency}
                isIncome
              />
            ))}
            {outsideTransferIncome > 0 && (
              <div className="px-6 py-4 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('pages.edit.outsideTransferIncome')}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {formatCurrency(outsideTransferIncome)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sublabel,
  valueColor,
}: {
  label: string;
  value: string;
  sublabel?: string;
  valueColor?: string;
}) {
  return (
    <div className={`${CARD_CLASS} p-4`}>
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${valueColor ?? 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </p>
      {sublabel && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          {sublabel}
        </p>
      )}
    </div>
  );
}

function PeriodCategoryRow({
  periodCategory,
  formatCurrency,
  isIncome = false,
}: {
  periodCategory: BudgetPeriodCategory;
  formatCurrency: (amount: number) => string;
  isIncome?: boolean;
}) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const name = getCategoryName(periodCategory, {
    transfersFrom: (account) => t('lineNames.transfersFrom', { name: account }),
    unknown: t('lineNames.unknown'),
  });
  const budgeted = Number(periodCategory.effectiveBudget);
  const spent = Number(periodCategory.actualAmount);
  const rolloverIn = Number(periodCategory.rolloverIn);
  const rolloverOut = Number(periodCategory.rolloverOut);
  const remaining = budgeted - spent;
  const percentUsed = budgeted > 0
    ? Math.round((spent / budgeted) * 10000) / 100
    : 0;

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {name}
          </span>
          {rolloverIn !== 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
              {t('periodDetail.rolloverBadge', { amount: formatCurrency(rolloverIn) })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            {formatCurrency(spent)} / {formatCurrency(budgeted)}
          </span>
          {!isIncome && (
            <span
              className={`font-medium ${
                percentUsed > 100
                  ? 'text-red-600 dark:text-red-400'
                  : percentUsed > 80
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-green-600 dark:text-green-400'
              }`}
            >
              {formatPercentTrimmed(percentUsed)}
            </span>
          )}
        </div>
      </div>
      {!isIncome && <BudgetProgressBar percentUsed={percentUsed} />}
      <div className="flex items-center justify-between mt-1">
        <div className="text-xs text-gray-400 dark:text-gray-500">
          {!isIncome && (
            remaining >= 0
              ? t('periodDetail.underBudgetLabel', { amount: formatCurrency(remaining) })
              : t('periodDetail.overBudgetLabel', { amount: formatCurrency(Math.abs(remaining)) })
          )}
        </div>
        {rolloverOut !== 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {t('periodDetail.carriedForward', { amount: formatCurrency(rolloverOut) })}
          </span>
        )}
      </div>
    </div>
  );
}
