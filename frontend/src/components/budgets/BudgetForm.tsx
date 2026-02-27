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
  Budget,
  UpdateBudgetData,
} from '@/types/budget';

const BUDGET_TYPES = ['MONTHLY', 'ANNUAL', 'PAY_PERIOD'] as const;
const STRATEGIES = ['FIXED', 'ROLLOVER', 'ZERO_BASED', 'FIFTY_THIRTY_TWENTY'] as const;

const budgetFormSchema = z.object({
  name: z.string().min(1, 'Budget name is required').max(255, 'Budget name must be 255 characters or less'),
  description: z.string().max(1000, 'Description must be 1000 characters or less').optional().or(z.literal('')),
  budgetType: z.enum(BUDGET_TYPES),
  strategy: z.enum(STRATEGIES),
  baseIncome: z.number().min(0).optional(),
  isActive: z.boolean(),
});

type BudgetFormData = z.infer<typeof budgetFormSchema>;

interface BudgetFormProps {
  budget: Budget;
  onSave: (data: UpdateBudgetData) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

const TYPE_OPTIONS: Array<{ value: (typeof BUDGET_TYPES)[number]; label: string }> = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'PAY_PERIOD', label: 'Pay Period' },
];

const STRATEGY_OPTIONS: Array<{ value: (typeof STRATEGIES)[number]; label: string }> = [
  { value: 'FIXED', label: 'Fixed' },
  { value: 'ROLLOVER', label: 'Rollover' },
  { value: 'ZERO_BASED', label: 'Zero-Based' },
  { value: 'FIFTY_THIRTY_TWENTY', label: '50/30/20' },
];

export function BudgetForm({
  budget,
  onSave,
  onCancel,
  isSaving = false,
}: BudgetFormProps) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<BudgetFormData>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: {
      name: budget.name,
      description: budget.description ?? '',
      budgetType: budget.budgetType,
      strategy: budget.strategy,
      baseIncome: budget.baseIncome !== null ? budget.baseIncome : undefined,
      isActive: budget.isActive,
    },
  });

  const onSubmit = async (formData: BudgetFormData) => {
    const data: UpdateBudgetData = {
      name: formData.name.trim(),
      description: formData.description?.trim() || undefined,
      budgetType: formData.budgetType,
      strategy: formData.strategy,
      baseIncome: formData.baseIncome ?? undefined,
    };

    await onSave(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Budget Name"
        {...register('name')}
        error={errors.name?.message}
        required
        maxLength={255}
      />

      <Input
        label="Description (optional)"
        {...register('description')}
        error={errors.description?.message}
        placeholder="Budget description"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Budget Type
        </label>
        <select
          {...register('budgetType')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {errors.budgetType && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.budgetType.message}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Strategy
        </label>
        <select
          {...register('strategy')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {STRATEGY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {errors.strategy && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.strategy.message}</p>
        )}
      </div>

      <Controller
        name="baseIncome"
        control={control}
        render={({ field }) => (
          <CurrencyInput
            label="Base Income (optional)"
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            allowNegative={false}
            prefix={getCurrencySymbol(budget.currencyCode)}
            placeholder="Expected monthly income"
          />
        )}
      />

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="isActive"
          {...register('isActive')}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <label
          htmlFor="isActive"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Active
        </label>
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
}
