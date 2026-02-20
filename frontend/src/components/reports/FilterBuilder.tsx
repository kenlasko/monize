'use client';

import { useMemo } from 'react';
import { FilterGroup, FilterCondition, FilterField } from '@/types/custom-report';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';

interface FilterBuilderProps {
  value: FilterGroup[];
  onChange: (groups: FilterGroup[]) => void;
  accounts: Account[];
  categories: Category[];
  payees: Payee[];
}

const FIELD_OPTIONS: { value: FilterField; label: string }[] = [
  { value: 'account', label: 'Account' },
  { value: 'category', label: 'Category' },
  { value: 'payee', label: 'Payee' },
  { value: 'text', label: 'Text' },
];

const ENTITY_FIELDS: FilterField[] = ['account', 'category', 'payee'];

export function FilterBuilder({ value, onChange, accounts, categories, payees }: FilterBuilderProps) {
  const accountOptions: MultiSelectOption[] = useMemo(() =>
    [...accounts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ value: a.id, label: a.name })),
    [accounts]
  );

  const categoryOptions: MultiSelectOption[] = useMemo(() => {
    const specialOptions: MultiSelectOption[] = [
      { value: 'uncategorized', label: 'Uncategorized' },
      { value: 'transfer', label: 'Transfers' },
    ];
    const buildOptions = (parentId: string | null = null): MultiSelectOption[] => {
      return categories
        .filter(c => c.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(cat => {
          const children = buildOptions(cat.id);
          return [{
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          }];
        });
    };
    return [...specialOptions, ...buildOptions()];
  }, [categories]);

  const payeeOptions: MultiSelectOption[] = useMemo(() =>
    [...payees]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name })),
    [payees]
  );

  const getValueOptions = (field: FilterField): MultiSelectOption[] => {
    switch (field) {
      case 'account':
        return accountOptions;
      case 'category':
        return categoryOptions;
      case 'payee':
        return payeeOptions;
      default:
        return [];
    }
  };

  const addGroup = () => {
    onChange([...value, { conditions: [{ field: 'category', value: [] }] }]);
  };

  const removeGroup = (groupIndex: number) => {
    onChange(value.filter((_, i) => i !== groupIndex));
  };

  const addCondition = (groupIndex: number) => {
    const updated = value.map((group, i) => {
      if (i !== groupIndex) return group;
      return {
        ...group,
        conditions: [...group.conditions, { field: 'category' as FilterField, value: [] as string[] }],
      };
    });
    onChange(updated);
  };

  const removeCondition = (groupIndex: number, conditionIndex: number) => {
    const updated = value.map((group, i) => {
      if (i !== groupIndex) return group;
      const newConditions = group.conditions.filter((_, ci) => ci !== conditionIndex);
      return { ...group, conditions: newConditions };
    });
    // Remove group if no conditions left
    onChange(updated.filter((g) => g.conditions.length > 0));
  };

  const updateCondition = (
    groupIndex: number,
    conditionIndex: number,
    update: Partial<FilterCondition>,
  ) => {
    const updated = value.map((group, i) => {
      if (i !== groupIndex) return group;
      return {
        ...group,
        conditions: group.conditions.map((cond, ci) => {
          if (ci !== conditionIndex) return cond;
          const newCond = { ...cond, ...update };
          // Reset value when field changes
          if (update.field && update.field !== cond.field) {
            newCond.value = ENTITY_FIELDS.includes(update.field) ? [] : '';
          }
          return newCond;
        }),
      };
    });
    onChange(updated);
  };

  if (value.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          No filters — all transactions included
        </p>
        <button
          type="button"
          onClick={addGroup}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded-md transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add filter group
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {value.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="flex items-center justify-center py-2">
              <span className="px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 rounded-full">
                AND
              </span>
            </div>
          )}
          <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-3 relative">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Match any
              </span>
              <button
                type="button"
                onClick={() => removeGroup(gi)}
                className="p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                title="Remove group"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-2">
              {group.conditions.map((condition, ci) => (
                <div key={ci}>
                  {ci > 0 && (
                    <div className="flex items-center justify-center py-1">
                      <span className="px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-full">
                        OR
                      </span>
                    </div>
                  )}
                  <div className="grid grid-cols-[auto_1fr_auto] items-start gap-2">
                    <select
                      value={condition.field}
                      onChange={(e) =>
                        updateCondition(gi, ci, { field: e.target.value as FilterField })
                      }
                      className="rounded-md border border-gray-300 shadow-sm px-2 py-1.5 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none mt-0.5"
                    >
                      {FIELD_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>

                    {condition.field === 'text' ? (
                      <input
                        type="text"
                        value={condition.value as string}
                        onChange={(e) => updateCondition(gi, ci, { value: e.target.value })}
                        placeholder="Search text..."
                        className="min-w-0 rounded-md border border-gray-300 shadow-sm px-2 py-1.5 text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    ) : (
                      <MultiSelect
                        options={getValueOptions(condition.field)}
                        value={Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : []}
                        onChange={(values) => updateCondition(gi, ci, { value: values })}
                        placeholder={`Select ${FIELD_OPTIONS.find((o) => o.value === condition.field)?.label}...`}
                      />
                    )}

                    <button
                      type="button"
                      onClick={() => removeCondition(gi, ci)}
                      className="flex-shrink-0 p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors mt-0.5"
                      title="Remove condition"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => addCondition(gi)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add OR condition
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addGroup}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 rounded-md transition-colors"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Add AND group
      </button>
    </div>
  );
}
