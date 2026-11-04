'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Button } from '@/components/ui/Button';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Category } from '@/types/category';
import { LOAN_FEE_BASES, LOAN_FEE_CALCULATIONS, MAX_LOAN_FEES } from '@/types/loan-fee';
import { buildCategoryLabelMap, buildCategoryTree } from '@/lib/categoryUtils';
import { getCurrencySymbol, getDecimalPlacesForCurrency } from '@/lib/format';
import {
  LOAN_FEE_CALCULATION_KEYS,
  LoanFeeDraft,
  LoanFeeDraftErrors,
  newLoanFeeDraft,
} from '@/lib/loan-fees';

interface LoanFeesEditorProps {
  fees: LoanFeeDraft[];
  onChange: (fees: LoanFeeDraft[]) => void;
  categories: Category[];
  currencyCode: string;
  /** Per-row problems from `loanFeeDraftErrors`; shown only when given. */
  errors?: LoanFeeDraftErrors[];
  /** Render the category list in a portal (inside a modal). */
  usePortal?: boolean;
  /**
   * Create a category from a name typed into a fee's picker (the "+ Create"
   * option every category picker offers, through `createCategoryFromInput`)
   * and answer it, or null when nothing was created. The parent adds it to
   * `categories`; the editor selects it on that fee. Absent, no create option.
   */
  onCreateCategory?: (name: string) => Promise<Category | null>;
}

const BASIS_KEYS = {
  PER_PAYMENT: 'perPayment',
  ANNUAL: 'annual',
} as const;

/**
 * The rows of a mortgage's fees (docs/specs/mortgage-fees.md): a name, the
 * category its line is booked to, how it is calculated and whether the value
 * is per payment or per year. A controlled view: the parent owns the drafts.
 */
export function LoanFeesEditor({
  fees,
  onChange,
  categories,
  currencyCode,
  errors,
  usePortal,
  onCreateCategory,
}: LoanFeesEditorProps) {
  const t = useTranslations('accounts');
  const categoryOptions = useMemo(() => {
    const labels = buildCategoryLabelMap(categories);
    return buildCategoryTree(categories).map(({ category }) => ({
      value: category.id,
      label: labels.get(category.id) ?? category.name,
    }));
  }, [categories]);
  const labels = useMemo(() => buildCategoryLabelMap(categories), [categories]);

  const update = (key: string, patch: Partial<LoanFeeDraft>) =>
    onChange(fees.map((fee) => (fee.key === key ? { ...fee, ...patch } : fee)));
  const remove = (key: string) => onChange(fees.filter((fee) => fee.key !== key));
  const createCategoryFor = (key: string) =>
    onCreateCategory
      ? async (name: string) => {
          const category = await onCreateCategory(name);
          if (category) update(key, { categoryId: category.id });
        }
      : undefined;
  const errorText = (code: string | undefined) =>
    code ? t(`loanFees.errors.${code}`) : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('loanFees.title')}</h4>
        <InfoTooltip text={t('loanFees.help')} placement="top" usePortal />
      </div>
      {fees.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('loanFees.none')}</p>
      )}
      {fees.map((fee, index) => {
        const rowErrors = errors?.[index] ?? {};
        const fixed = fee.calculation === 'FIXED';
        return (
          <div
            key={fee.key}
            className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3"
            data-testid="loan-fee-row"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                id={`loan-fee-name-${fee.key}`}
                label={t('loanFees.name')}
                value={fee.name}
                maxLength={100}
                onChange={(e) => update(fee.key, { name: e.target.value })}
                error={errorText(rowErrors.name)}
              />
              <Combobox
                label={t('loanFees.category')}
                aria-label={t('loanFees.category')}
                placeholder={
                  onCreateCategory
                    ? t('assetFields.selectOrCreateCategory')
                    : t('mortgageFields.selectCategory')
                }
                options={categoryOptions}
                value={fee.categoryId}
                initialDisplayValue={labels.get(fee.categoryId) ?? ''}
                onChange={(categoryId) => update(fee.key, { categoryId })}
                onCreateNew={createCategoryFor(fee.key)}
                allowCustomValue={!!onCreateCategory}
                valueIsId
                error={errorText(rowErrors.categoryId)}
                usePortal={usePortal}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Select
                id={`loan-fee-calculation-${fee.key}`}
                label={t('loanFees.calculation')}
                value={fee.calculation}
                options={LOAN_FEE_CALCULATIONS.map((value) => ({
                  value,
                  label: t(`loanFees.calculations.${LOAN_FEE_CALCULATION_KEYS[value]}`),
                }))}
                onChange={(e) =>
                  update(fee.key, {
                    calculation: e.target.value as LoanFeeDraft['calculation'],
                    value: undefined,
                  })
                }
              />
              <Select
                id={`loan-fee-basis-${fee.key}`}
                label={t('loanFees.basis')}
                value={fee.basis}
                options={LOAN_FEE_BASES.map((value) => ({
                  value,
                  label: t(`loanFees.bases.${BASIS_KEYS[value]}`),
                }))}
                onChange={(e) => update(fee.key, { basis: e.target.value as LoanFeeDraft['basis'] })}
              />
              {fixed ? (
                <CurrencyInput
                  id={`loan-fee-value-${fee.key}`}
                  label={t('loanFees.amount')}
                  prefix={getCurrencySymbol(currencyCode)}
                  decimalPlaces={getDecimalPlacesForCurrency(currencyCode)}
                  allowNegative={false}
                  value={fee.value}
                  onChange={(value) => update(fee.key, { value })}
                  error={errorText(rowErrors.value)}
                />
              ) : (
                <NumericInput
                  id={`loan-fee-value-${fee.key}`}
                  label={t('loanFees.rate')}
                  suffix="%"
                  decimalPlaces={6}
                  min={0}
                  max={100}
                  value={fee.value}
                  onChange={(value) => update(fee.key, { value })}
                  error={errorText(rowErrors.value)}
                />
              )}
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(fee.key)}>
                {t('loanFees.remove')}
              </Button>
            </div>
          </div>
        );
      })}
      {fees.length < MAX_LOAN_FEES && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...fees, newLoanFeeDraft()])}>
          {t('loanFees.add')}
        </Button>
      )}
    </div>
  );
}
