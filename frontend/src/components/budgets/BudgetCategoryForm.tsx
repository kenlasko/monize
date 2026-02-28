'use client';

import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { getCurrencySymbol } from '@/lib/format';
import type {
  BudgetCategory,
  UpdateBudgetCategoryData,
} from '@/types/budget';

const ROLLOVER_TYPES = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
const CATEGORY_GROUPS = ['', 'NEED', 'WANT', 'SAVING'] as const;

const budgetCategoryFormSchema = z.object({
  amount: z.number().min(0, 'Amount must be 0 or greater'),
  rolloverType: z.enum(ROLLOVER_TYPES),
  rolloverCap: z.string().max(20).optional().or(z.literal('')),
  flexGroup: z.string().max(100).optional().or(z.literal('')),
  categoryGroup: z.enum(CATEGORY_GROUPS),
  alertWarnPercent: z.string().regex(/^\d*$/, 'Must be a number'),
  alertCriticalPercent: z.string().regex(/^\d*$/, 'Must be a number'),
  notes: z.string().max(1000).optional().or(z.literal('')),
});

type BudgetCategoryFormData = z.infer<typeof budgetCategoryFormSchema>;

interface BudgetCategoryFormProps {
  category: BudgetCategory;
  currencyCode: string;
  onSave: (data: UpdateBudgetCategoryData) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

const ROLLOVER_OPTIONS: Array<{ value: (typeof ROLLOVER_TYPES)[number]; label: string }> = [
  { value: 'NONE', label: 'None (resets each period)' },
  { value: 'MONTHLY', label: 'Monthly rollover' },
  { value: 'QUARTERLY', label: 'Quarterly rollover' },
  { value: 'ANNUAL', label: 'Annual rollover' },
];

const GROUP_OPTIONS: Array<{ value: (typeof CATEGORY_GROUPS)[number]; label: string }> = [
  { value: '', label: 'None' },
  { value: 'NEED', label: 'Need' },
  { value: 'WANT', label: 'Want' },
  { value: 'SAVING', label: 'Saving' },
];

export function BudgetCategoryForm({
  category,
  currencyCode,
  onSave,
  onCancel,
  isSaving = false,
}: BudgetCategoryFormProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors },
  } = useForm<BudgetCategoryFormData>({
    resolver: zodResolver(budgetCategoryFormSchema),
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
        Edit: {category.category?.parent ? `${category.category.parent.name}: ${category.category.name}` : category.category?.name ?? 'Category'}
      </h3>

      <Controller
        name="amount"
        control={control}
        render={({ field }) => (
          <CurrencyInput
            label="Budget Amount"
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            allowNegative={false}
            prefix={getCurrencySymbol(currencyCode)}
            required
            error={errors.amount?.message}
          />
        )}
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Rollover Type
        </label>
        <select
          {...register('rolloverType')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {ROLLOVER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {watchedRolloverType !== 'NONE' && (
        <Input
          label="Rollover Cap (optional)"
          type="number"
          {...register('rolloverCap')}
          error={errors.rolloverCap?.message}
          min="0"
          step="0.01"
          placeholder="No cap"
        />
      )}

      <Input
        label="Flex Group (optional)"
        {...register('flexGroup')}
        error={errors.flexGroup?.message}
        placeholder="e.g., Fun Money"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Category Group (50/30/20)
        </label>
        <select
          {...register('categoryGroup')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {GROUP_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Warning at (%)"
          type="number"
          {...register('alertWarnPercent')}
          error={errors.alertWarnPercent?.message}
          min="0"
          max="100"
        />
        <Input
          label="Critical at (%)"
          type="number"
          {...register('alertCriticalPercent')}
          error={errors.alertCriticalPercent?.message}
          min="0"
          max="100"
        />
      </div>

      <Input
        label="Notes (optional)"
        {...register('notes')}
        error={errors.notes?.message}
        placeholder="Notes about this category budget"
      />

      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
