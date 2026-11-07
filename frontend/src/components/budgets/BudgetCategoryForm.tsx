'use client';

import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { getCurrencySymbol } from '@/lib/format';
import type {
  BudgetCategory,
  UpdateBudgetCategoryData,
} from '@/types/budget';

const ROLLOVER_TYPES = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
const CATEGORY_GROUPS = ['', 'NEED', 'WANT', 'SAVING'] as const;

const buildBudgetCategoryFormSchema = (t: (key: string) => string) => z.object({
  amount: z.number().min(0, t('categoryValidation.amountMin')),
  rolloverType: z.enum(ROLLOVER_TYPES),
  rolloverCap: z.string().max(20).optional().or(z.literal('')),
  flexGroup: z.string().max(100).optional().or(z.literal('')),
  categoryGroup: z.enum(CATEGORY_GROUPS),
  alertWarnPercent: z.string().regex(/^\d*$/, t('categoryValidation.mustBeNumber')),
  alertCriticalPercent: z.string().regex(/^\d*$/, t('categoryValidation.mustBeNumber')),
  notes: z.string().max(1000).optional().or(z.literal('')),
});

type BudgetCategoryFormData = z.infer<ReturnType<typeof buildBudgetCategoryFormSchema>>;

interface BudgetCategoryFormProps {
  category: BudgetCategory;
  currencyCode: string;
  onSave: (data: UpdateBudgetCategoryData) => Promise<void>;
  onCancel: () => void;
  /** Offers a "Remove from budget" action; the caller confirms and deletes. */
  onRemove?: () => void;
  isSaving?: boolean;
}

const ROLLOVER_VALUES = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
const GROUP_VALUES = ['', 'NEED', 'WANT', 'SAVING'] as const;

export function BudgetCategoryForm({
  category,
  currencyCode,
  onSave,
  onCancel,
  onRemove,
  isSaving = false,
}: BudgetCategoryFormProps) {
  const t = useTranslations('budgets');
  const tc = useTranslations('common');
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<BudgetCategoryFormData>({
    resolver: zodResolver(buildBudgetCategoryFormSchema(t)),
    defaultValues: {
      amount: category.amount,
      rolloverType: category.rolloverType,
      rolloverCap: category.rolloverCap !== null ? String(category.rolloverCap) : '',
      flexGroup: category.flexGroup ?? '',
      categoryGroup: category.categoryGroup ?? '',
      alertWarnPercent: String(category.alertWarnPercent),
      alertCriticalPercent: String(category.alertCriticalPercent),
      notes: category.notes ?? '',
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const watchedRolloverType = watch('rolloverType');

  const onSubmit = async (formData: BudgetCategoryFormData) => {
    const data: UpdateBudgetCategoryData = {
      amount: formData.amount,
      rolloverType: formData.rolloverType,
      rolloverCap: formData.rolloverCap ? parseFloat(formData.rolloverCap) : undefined,
      flexGroup: formData.flexGroup || undefined,
      categoryGroup: formData.categoryGroup || undefined,
      alertWarnPercent: parseInt(formData.alertWarnPercent) || 80,
      alertCriticalPercent: parseInt(formData.alertCriticalPercent) || 95,
      notes: formData.notes || undefined,
    };

    await onSave(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('categoryForm.editTitle', { name: category.category?.parent ? `${category.category.parent.name}: ${category.category.name}` : category.category?.name ?? 'Category' })}
      </h3>

      <Controller
        name="amount"
        control={control}
        render={({ field }) => (
          <CurrencyInput
            label={t('categoryForm.budgetAmount')}
            value={field.value}
            onChange={field.onChange}
            name={field.name}
            onBlur={field.onBlur}
            allowNegative={false}
            prefix={getCurrencySymbol(currencyCode)}
            required
            error={errors.amount?.message}
          />
        )}
      />

      <div>
        <div className="flex items-center mb-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('categoryForm.rolloverType')}
          </label>
          <InfoTooltip text={t('categoryForm.rolloverTypeTooltip')} learnMore="budgetRollover" />
        </div>
        <select
          {...register('rolloverType')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {ROLLOVER_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`categoryForm.rolloverOptions.${value}`)}
            </option>
          ))}
        </select>
      </div>

      {watchedRolloverType !== 'NONE' && (
        <Controller
          name="rolloverCap"
          control={control}
          render={({ field }) => (
            <CurrencyInput
              label={t('categoryForm.rolloverCap')}
              value={field.value === '' || field.value === undefined ? undefined : Number(field.value)}
              onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
              name={field.name}
              onBlur={field.onBlur}
              allowNegative={false}
              prefix={getCurrencySymbol(currencyCode)}
              error={errors.rolloverCap?.message}
              placeholder={t('categoryForm.rolloverCapPlaceholder')}
            />
          )}
        />
      )}

      <Input
        label={t('categoryForm.flexGroup')}
        {...register('flexGroup')}
        error={errors.flexGroup?.message}
        placeholder={t('categoryForm.flexGroupPlaceholder')}
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('categoryForm.categoryGroup')}
        </label>
        <select
          {...register('categoryGroup')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {GROUP_VALUES.map((value) => (
            <option key={value} value={value}>
              {value === '' ? t('categoryForm.groupOptions.none') : t(`categoryForm.groupOptions.${value}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Controller
          name="alertWarnPercent"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('categoryForm.warningAt')}
              decimalPlaces={0}
              min={0}
              max={100}
              suffix="%"
              value={field.value === '' ? undefined : Number(field.value)}
              onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
              name={field.name}
              onBlur={field.onBlur}
              error={errors.alertWarnPercent?.message}
            />
          )}
        />
        <Controller
          name="alertCriticalPercent"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('categoryForm.criticalAt')}
              decimalPlaces={0}
              min={0}
              max={100}
              suffix="%"
              value={field.value === '' ? undefined : Number(field.value)}
              onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
              name={field.name}
              onBlur={field.onBlur}
              error={errors.alertCriticalPercent?.message}
            />
          )}
        />
      </div>

      <Input
        label={t('categoryForm.notes')}
        {...register('notes')}
        error={errors.notes?.message}
        placeholder={t('categoryForm.notesPlaceholder')}
      />

      <div className={`flex flex-wrap gap-3 pt-2 ${onRemove ? 'justify-between' : 'justify-end'}`}>
        {onRemove && (
          <Button type="button" variant="danger" onClick={onRemove} disabled={isSaving}>
            {t('categoryForm.remove')}
          </Button>
        )}
        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? t('categoryForm.saving') : tc('save')}
          </Button>
        </div>
      </div>
    </form>
  );
}
