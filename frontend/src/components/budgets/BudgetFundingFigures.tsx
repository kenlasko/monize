'use client';

import { useTranslations } from 'next-intl';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface BudgetFundingFiguresProps {
  /** Actual Income: the income lines on an Income or Expense category. */
  categoryIncome: number | null;
  /**
   * Transfer Funding: transfer income lines, income lines on a Transfer
   * category and the transfers counted in from excluded accounts.
   */
  transferFunding: number | null;
  /** Total Budget Funding, the two together. */
  totalFunding: number | null;
  /** The translated cause shown beside a figure the server withheld (`null`). */
  partialReason?: string;
  formatCurrency: (amount: number) => string;
  /** The caption over the three figures, e.g. "This period" or "Planned". */
  caption?: string;
}

/**
 * A budget's income as its three figures (docs/specs/transfer-categories.md
 * section 6.2): what was earned, what transfers brought in, and the two
 * together. Each figure comes from the server or the plan; nothing is derived
 * here. A caller whose split is unknown (a period closed before it was
 * recorded) does not render this at all, rather than showing a zero.
 */
export function BudgetFundingFigures({
  categoryIncome,
  transferFunding,
  totalFunding,
  partialReason,
  formatCurrency,
  caption,
}: BudgetFundingFiguresProps) {
  const t = useTranslations('budgets');
  const rows = [
    { key: 'actualIncome', label: t('funding.actualIncome'), value: categoryIncome },
    { key: 'transferFunding', label: t('funding.transferFunding'), value: transferFunding },
  ];

  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 p-3">
      {caption && (
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
          {caption}
        </p>
      )}
      <dl className="space-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between">
            <dt className="text-gray-600 dark:text-gray-300">{row.label}</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              {row.value === null ? <UnknownAmount reasonText={partialReason} /> : formatCurrency(row.value)}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-1 mt-1">
          <dt className="font-medium text-gray-900 dark:text-gray-100">
            {t('funding.totalFunding')}
          </dt>
          <dd className="font-semibold text-green-600 dark:text-green-400">
            {totalFunding === null ? <UnknownAmount reasonText={partialReason} /> : formatCurrency(totalFunding)}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{t('funding.hint')}</p>
    </div>
  );
}
