'use client';

import { useTranslations } from 'next-intl';
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PayrollDeductionRule } from '@/types/payroll-deduction';

interface PayrollDeductionRuleListProps {
  rules: PayrollDeductionRule[];
  onEdit: (rule: PayrollDeductionRule) => void;
  onDelete: (rule: PayrollDeductionRule) => void;
}

/** The rules as rows: which bill, which category, the maximum, the reset and the per-paycheque figure. */
export function PayrollDeductionRuleList({ rules, onEdit, onDelete }: PayrollDeductionRuleListProps) {
  const t = useTranslations('taxes.payroll');
  const tc = useTranslations('common');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>{t('list.bill')}</Th>
            <Th>{t('list.category')}</Th>
            <Th align="right">{t('list.yearlyMaximum')}</Th>
            <Th>{t('list.resetsOn')}</Th>
            <Th align="right">{t('list.perPaycheque')}</Th>
            <Th align="right">{t('list.actions')}</Th>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <Td>{rule.scheduledTransactionName}</Td>
              <Td>{rule.categoryName}</Td>
              <Td align="right">
                {formatCurrency(rule.yearlyMaximum, rule.currencyCode)}
                {/* The next period's own maximum, when it differs (spec section 11). */}
                {rule.nextPeriod?.scheduled && rule.nextPeriod.yearlyMaximum !== rule.yearlyMaximum && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {t('list.nextMaximum', {
                      date: formatDate(rule.nextPeriod.periodStart),
                      amount: formatCurrency(rule.nextPeriod.yearlyMaximum, rule.currencyCode),
                    })}
                  </span>
                )}
              </Td>
              <Td>{formatDate(rule.nextResetOn)}</Td>
              <Td align="right">
                {rule.expectedPerPaycheque === null ? (
                  <span className="text-amber-600 dark:text-amber-400">{t('list.expectedMissing')}</span>
                ) : (
                  <>
                    {formatCurrency(rule.expectedPerPaycheque, rule.currencyCode)}
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {rule.expectedSource === 'line' ? t('list.fromLine') : t('list.entered')}
                    </span>
                  </>
                )}
              </Td>
              <Td align="right">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(rule)}
                    aria-label={`${tc('edit')} ${rule.categoryName}`}
                    className="p-1 rounded text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <PencilIcon className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(rule)}
                    aria-label={`${tc('delete')} ${rule.categoryName}`}
                    className="p-1 rounded text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
