'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { getCurrencySymbol } from '@/lib/format';
import type {
  Budget,
  UpdateBudgetData,
  BudgetType,
  BudgetStrategy,
} from '@/types/budget';

interface BudgetFormProps {
  budget: Budget;
  onSave: (data: UpdateBudgetData) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

const TYPE_OPTIONS: Array<{ value: BudgetType; label: string }> = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'PAY_PERIOD', label: 'Pay Period' },
];

const STRATEGY_OPTIONS: Array<{ value: BudgetStrategy; label: string }> = [
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
  const [name, setName] = useState(budget.name);
  const [description, setDescription] = useState(budget.description ?? '');
  const [budgetType, setBudgetType] = useState<BudgetType>(budget.budgetType);
  const [strategy, setStrategy] = useState<BudgetStrategy>(budget.strategy);
  const [baseIncome, setBaseIncome] = useState<number | undefined>(
    budget.baseIncome !== null ? budget.baseIncome : undefined,
  );
  const [isActive, setIsActive] = useState(budget.isActive);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const data: UpdateBudgetData = {
      name: name.trim(),
      description: description.trim() || undefined,
      budgetType,
      strategy,
      baseIncome: baseIncome ?? undefined,
    };

    await onSave(data);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Budget Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={255}
      />

      <Input
        label="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Budget description"
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Budget Type
        </label>
        <select
          value={budgetType}
          onChange={(e) => setBudgetType(e.target.value as BudgetType)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Strategy
        </label>
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as BudgetStrategy)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        >
          {STRATEGY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <CurrencyInput
        label="Base Income (optional)"
        value={baseIncome}
        onChange={setBaseIncome}
        allowNegative={false}
        prefix={getCurrencySymbol(budget.currencyCode)}
        placeholder="Expected monthly income"
      />

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="isActive"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
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
