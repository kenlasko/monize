'use client';

import { Button } from '@/components/ui/Button';
import { CsvTransferRule } from '@/lib/import';

interface CsvTransferRulesProps {
  rules: CsvTransferRule[];
  onChange: (rules: CsvTransferRule[]) => void;
}

export function CsvTransferRules({ rules, onChange }: CsvTransferRulesProps) {
  const addRule = () => {
    onChange([...rules, { type: 'payee', pattern: '', accountName: '' }]);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, field: keyof CsvTransferRule, value: string) => {
    onChange(rules.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Transfer Detection Rules
        </h4>
        <Button variant="outline" size="sm" onClick={addRule}>
          Add Rule
        </Button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Define patterns to identify transactions that are transfers between accounts.
        Matching is case-insensitive and uses &quot;contains&quot; logic.
      </p>
      {rules.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          No transfer rules defined. Transfers will not be detected automatically.
        </p>
      )}
      {rules.map((rule, index) => (
        <div key={index} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
          <select
            value={rule.type}
            onChange={(e) => updateRule(index, 'type', e.target.value)}
            className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value="payee">Payee contains</option>
            <option value="category">Category contains</option>
          </select>
          <input
            type="text"
            value={rule.pattern}
            onChange={(e) => updateRule(index, 'pattern', e.target.value)}
            placeholder="Pattern..."
            className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">as transfer to</span>
          <input
            type="text"
            value={rule.accountName}
            onChange={(e) => updateRule(index, 'accountName', e.target.value)}
            placeholder="Account name..."
            className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <button
            onClick={() => removeRule(index)}
            className="text-red-500 hover:text-red-700 text-sm px-1"
            title="Remove rule"
          >
            X
          </button>
        </div>
      ))}
    </div>
  );
}
