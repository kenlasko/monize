'use client';

import { useTranslations } from 'next-intl';
import { Controller, type Control, type FieldErrors } from 'react-hook-form';
import { Combobox } from '@/components/ui/Combobox';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { RemoveSplitLineButton } from '@/components/transactions/SplitLineButtons';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getCurrencySymbol } from '@/lib/format';
import type { PayrollResetPeriod } from '@/types/payroll-deduction';

/** One category row of the form. */
export interface PayrollDeductionLineValues {
  categoryId: string;
  yearlyMaximum: number;
  expectedPerPaycheque?: number;
  /** Set when the expected figure was prefilled from the ledger. */
  suggested?: boolean;
  /** Set when the maximum was estimated from what the category has collected. */
  maximumSuggested?: boolean;
  /** The next period's maximum; empty carries this period's (spec section 11). */
  nextYearlyMaximum?: number;
  nextExpectedPerPaycheque?: number;
  /** The next period's fields are open. */
  showNext?: boolean;
}

/** The form's values: one bill and one reset, shared by every row. */
export interface PayrollDeductionFormValues {
  scheduledTransactionId: string;
  resetPeriod: PayrollResetPeriod;
  resetDate: string;
  lines: PayrollDeductionLineValues[];
}

interface PayrollDeductionLineFieldsProps {
  index: number;
  control: Control<PayrollDeductionFormValues>;
  errors?: FieldErrors<PayrollDeductionLineValues>;
  categoryOptions: { value: string; label: string }[];
  /** The bill's deduction for the chosen category, or `null` when it has none. */
  lineAmount: number | null;
  currencyCode?: string;
  /** The expected figure was prefilled from the ledger. */
  suggested: boolean;
  /** The maximum was estimated from what the category has already collected. */
  maximumSuggested: boolean;
  onCategoryChange: (value: string) => void;
  /** Absent on the only row, and when editing a single rule. */
  onRemove?: () => void;
  /** The current period's first and last days, and the next period's first. */
  period: { start: string; end: string; nextStart: string };
  /** Whether the next period's fields are open. */
  showNext: boolean;
  onShowNext: () => void;
}

/**
 * One category of a payroll bill: the deduction line it caps, the maximum, and
 * the expected figure when the bill's line does not supply one.
 */
export function PayrollDeductionLineFields({
  index,
  control,
  errors,
  categoryOptions,
  lineAmount,
  currencyCode,
  suggested,
  maximumSuggested,
  onCategoryChange,
  onRemove,
  period,
  showNext,
  onShowNext,
}: PayrollDeductionLineFieldsProps) {
  const t = useTranslations('taxes.payroll');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const ordinal = index + 1;
  // The bill's currency symbol in the box, as every money entry in Monize shows it.
  const symbol = currencyCode ? getCurrencySymbol(currencyCode) : undefined;

  return (
    <div className="relative rounded-md border border-gray-200 dark:border-gray-700 p-3 space-y-3">
      {/* The same trash button a split line has, pinned to the row's top-right corner. */}
      {onRemove && (
        <div className="absolute top-2 right-2">
          <RemoveSplitLineButton onClick={onRemove} title={t('form.removeCategory', { index: ordinal })} />
        </div>
      )}
      <div className={onRemove ? 'pr-8' : undefined}>
        <div>
          <Controller
            control={control}
            name={`lines.${index}.categoryId` as const}
            render={({ field }) => (
              <Combobox
                label={t('form.categoryLabel', { index: ordinal })}
                placeholder={t('form.categoryPlaceholder')}
                options={categoryOptions}
                value={field.value}
                onChange={onCategoryChange}
                error={errors?.categoryId?.message}
                valueIsId
                usePortal
              />
            )}
          />
        </div>
      </div>

      {showNext && (
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('form.thisPeriod', { start: formatDate(period.start), end: formatDate(period.end) })}
        </p>
      )}
      {/* Label row above each box, so the two boxes share one baseline. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center mb-1">
            <label htmlFor={`payroll-yearly-maximum-${index}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('form.yearlyMaximumLabel')}
            </label>
            <InfoTooltip text={t('form.yearlyMaximumHelp')} placement="bottom" usePortal />
          </div>
          <Controller
            control={control}
            name={`lines.${index}.yearlyMaximum` as const}
            render={({ field }) => (
              <CurrencyInput
                id={`payroll-yearly-maximum-${index}`}
                prefix={symbol}
                allowNegative={false}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
                error={errors?.yearlyMaximum?.message}
              />
            )}
          />
          {maximumSuggested && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('form.yearlyMaximumSuggested')}</p>
          )}
        </div>

        {lineAmount !== null && (
          <p className="self-end text-sm text-gray-600 dark:text-gray-400">
            {t('form.expectedFromLine', { amount: formatCurrency(lineAmount, currencyCode) })}
          </p>
        )}
        {lineAmount === null && (
          <div>
            <div className="flex items-center mb-1">
              <label htmlFor={`payroll-expected-per-paycheque-${index}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('form.expectedLabel')}
              </label>
              <InfoTooltip text={t('form.expectedHelp')} placement="bottom" usePortal />
            </div>
            <Controller
              control={control}
              name={`lines.${index}.expectedPerPaycheque` as const}
              render={({ field }) => (
                <CurrencyInput
                  id={`payroll-expected-per-paycheque-${index}`}
                  prefix={symbol}
                  allowNegative={false}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    error={errors?.expectedPerPaycheque?.message}
                  />
                )}
              />
            {suggested && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('form.expectedSuggested')}</p>
            )}
          </div>
        )}
      </div>

      {!showNext && (
        <button
          type="button"
          onClick={onShowNext}
          className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 focus-visible:outline-2 focus-visible:outline-blue-500 rounded"
        >
          {t('form.setNextPeriod', { date: formatDate(period.nextStart) })}
        </button>
      )}
      {showNext && (
        <div className="space-y-3 border-t border-gray-200 dark:border-gray-700 pt-3">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('form.nextPeriod', { date: formatDate(period.nextStart) })}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center mb-1">
                <label htmlFor={`payroll-next-yearly-maximum-${index}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('form.nextYearlyMaximumLabel')}
                </label>
                <InfoTooltip text={t('form.nextYearlyMaximumHelp')} placement="bottom" usePortal />
              </div>
              <Controller
                control={control}
                name={`lines.${index}.nextYearlyMaximum` as const}
                render={({ field }) => (
                  <CurrencyInput
                    id={`payroll-next-yearly-maximum-${index}`}
                    prefix={symbol}
                    allowNegative={false}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                    placeholder={t('form.sameAsThisPeriod')}
                    error={errors?.nextYearlyMaximum?.message}
                  />
                )}
              />
            </div>
            {lineAmount === null && (
              <div>
                <div className="flex items-center mb-1">
                  <label htmlFor={`payroll-next-expected-per-paycheque-${index}`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('form.nextExpectedLabel')}
                  </label>
                  <InfoTooltip text={t('form.nextExpectedHelp')} placement="bottom" usePortal />
                </div>
                <Controller
                  control={control}
                  name={`lines.${index}.nextExpectedPerPaycheque` as const}
                  render={({ field }) => (
                    <CurrencyInput
                      id={`payroll-next-expected-per-paycheque-${index}`}
                      prefix={symbol}
                      allowNegative={false}
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      placeholder={t('form.sameAsThisPeriod')}
                      error={errors?.nextExpectedPerPaycheque?.message}
                    />
                  )}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
