'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { getCurrencySymbol } from '@/lib/format';
import type {
  BudgetCategory,
  UpdateBudgetCategoryData,
  RolloverType,
  CategoryGroup,
} from '@/types/budget';

interface BudgetCategoryFormProps {
  category: BudgetCategory;
  currencyCode: string;
  onSave: (data: UpdateBudgetCategoryData) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

const ROLLOVER_OPTIONS: Array<{ value: RolloverType; label: string }> = [
  { value: 'NONE', label: 'None (resets each period)' },
  { value: 'MONTHLY', label: 'Monthly rollover' },
  { value: 'QUARTERLY', label: 'Quarterly rollover' },
  { value: 'ANNUAL', label: 'Annual rollover' },
];

const GROUP_OPTIONS: Array<{ value: CategoryGroup | ''; label: string }> = [
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
  const [amount, setAmount] = useState<number | undefined>(category.amount);
  const [rolloverType, setRolloverType] = useState<RolloverType>(
    category.rolloverType,
  );
  const [rolloverCap, setRolloverCap] = useState(
    category.rolloverCap !== null ? String(category.rolloverCap) : '',
  );
  const [flexGroup, setFlexGroup] = useState(category.flexGroup ?? '');
  const [categoryGroup, setCategoryGroup] = useState<CategoryGroup | ''>(
    category.categoryGroup ?? '',
  );
  const [alertWarnPercent, setAlertWarnPercent] = useState(
    String(category.alertWarnPercent),
  );
  const [alertCriticalPercent, setAlertCriticalPercent] = useState(
    String(category.alertCriticalPercent),
  );
  const [notes, setNotes] = useState(category.notes ?? '');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount === undefined || amount < 0) return;

    const data: UpdateBudgetCategoryData = {
      amount,
      rolloverType,
      rolloverCap: rolloverCap ? parseFloat(rolloverCap) : undefined,
      flexGroup: flexGroup || undefined,
      categoryGroup: categoryGroup || undefined,
      alertWarnPercent: parseInt(alertWarnPercent) || 80,
      alertCriticalPercent: parseInt(alertCriticalPercent) || 95,
      notes: notes || undefined,
    };

    await onSave(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Edit: {category.category?.name ?? 'Category'}
      </h3>

      <CurrencyInput
        label="Budget Amount"
        value={amount}
        onChange={setAmount}
        allowNegative={false}
        prefix={getCurrencySymbol(currencyCode)}
        required
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Rollover Type
        </label>
        <select
          value={rolloverType}
          onChange={(e) => setRolloverType(e.target.value as RolloverType)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {ROLLOVER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {rolloverType !== 'NONE' && (
        <Input
          label="Rollover Cap (optional)"
          type="number"
          value={rolloverCap}
          onChange={(e) => setRolloverCap(e.target.value)}
          min="0"
          step="0.01"
          placeholder="No cap"
        />
      )}

      <Input
        label="Flex Group (optional)"
        value={flexGroup}
        onChange={(e) => setFlexGroup(e.target.value)}
        placeholder="e.g., Fun Money"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Category Group (50/30/20)
        </label>
        <select
          value={categoryGroup}
          onChange={(e) =>
            setCategoryGroup(e.target.value as CategoryGroup | '')
          }
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
          value={alertWarnPercent}
          onChange={(e) => setAlertWarnPercent(e.target.value)}
          min="0"
          max="100"
        />
        <Input
          label="Critical at (%)"
          type="number"
          value={alertCriticalPercent}
          onChange={(e) => setAlertCriticalPercent(e.target.value)}
          min="0"
          max="100"
        />
      </div>

      <Input
        label="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
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
