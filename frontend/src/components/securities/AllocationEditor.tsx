'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';

/** A single editable allocation row. `weight` is a percentage string (0-100). */
export interface AllocationRow {
  name: string;
  weight: string;
}

interface AllocationEditorProps {
  /** Section heading (e.g. the localized "Country allocation" label). */
  title: string;
  value: AllocationRow[];
  onChange: (rows: AllocationRow[]) => void;
  /** Combobox options for the name field (canonical list; custom allowed). */
  options: { value: string; label: string }[];
  /** Placeholder for the name combobox. */
  namePlaceholder: string;
}

const parseWeight = (raw: string): number => {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Repeatable {name, percentage} allocation editor used for an ETF/fund's manual
 * country breakdown. Fully controlled: the parent owns the rows (percentages as
 * strings) and converts to the stored decimal 0-1 form on submit. Shows a live
 * total, a computed read-only "Other" remainder when the rows sum to under
 * 100%, and an error when they exceed 100%.
 */
export function AllocationEditor({
  title,
  value,
  onChange,
  options,
  namePlaceholder,
}: AllocationEditorProps) {
  const t = useTranslations('securities');

  const total = useMemo(
    () => value.reduce((sum, row) => sum + parseWeight(row.weight), 0),
    [value],
  );
  const remainder = Math.round((100 - total) * 10000) / 10000;
  const overAllocated = total > 100.0001;

  const updateRow = (index: number, patch: Partial<AllocationRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addRow = () => {
    onChange([...value, { name: '', weight: '' }]);
  };

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {title}
        </span>
        <span
          className={`text-xs font-medium ${
            overAllocated
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-500 dark:text-gray-400'
          }`}
          data-testid="allocation-total"
        >
          {t('form.allocation.total', { total: total.toFixed(2) })}
        </span>
      </div>

      <div className="space-y-2">
        {value.map((row, index) => (
          <div key={index} className="flex gap-2 items-start">
            <div className="flex-1 min-w-0">
              <Combobox
                options={options}
                value={row.name}
                onChange={(val, label) =>
                  updateRow(index, { name: val || label })
                }
                placeholder={namePlaceholder}
                allowCustomValue
                usePortal
                aria-label={t('form.allocation.nameAriaLabel')}
              />
            </div>
            <div className="w-28">
              <Input
                type="number"
                min={0}
                max={100}
                step="any"
                inputMode="decimal"
                value={row.weight}
                onChange={(e) => updateRow(index, { weight: e.target.value })}
                placeholder="0"
                aria-label={t('form.allocation.weightAriaLabel')}
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="mt-2 p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
              title={t('form.allocation.removeRow')}
              aria-label={t('form.allocation.removeRow')}
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        ))}
      </div>

      {!overAllocated && remainder > 0.0001 && (
        <div className="flex justify-between mt-2 px-1 text-sm text-gray-500 dark:text-gray-400">
          <span>{t('form.allocation.other')}</span>
          <span data-testid="allocation-other">{remainder.toFixed(2)}%</span>
        </div>
      )}

      {overAllocated && (
        <p
          role="alert"
          className="mt-2 text-sm text-red-600 dark:text-red-400"
          data-testid="allocation-over-error"
        >
          {t('form.allocation.overError')}
        </p>
      )}

      <button
        type="button"
        onClick={addRow}
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
      >
        <PlusIcon className="h-4 w-4" />
        {t('form.allocation.addRow')}
      </button>
    </div>
  );
}
