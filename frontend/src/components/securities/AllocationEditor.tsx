'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Combobox } from '@/components/ui/Combobox';
import { NumericInput } from '@/components/ui/NumericInput';

import { useNumberFormat } from '@/hooks/useNumberFormat';
import { roundToDecimals } from '@/lib/format';
/** A single editable allocation row. `weight` is a percentage string (0-100). */
export interface AllocationRow {
  name: string;
  weight: string;
}

interface AllocationEditorProps {
  /** Optional in-box heading. Omit when the section already has a title above. */
  title?: string;
  value: AllocationRow[];
  onChange: (rows: AllocationRow[]) => void;
  /** Combobox options for the name field (canonical list; custom allowed). */
  options: { value: string; label: string }[];
  /** Placeholder for the name combobox. */
  namePlaceholder: string;
  /** Label for the "add a row" button. Defaults to the country wording. */
  addRowLabel?: string;
  /** Accessible name for the name combobox. Defaults to the country wording. */
  nameAriaLabel?: string;
  /**
   * When set, each option in the name dropdown gets a delete control wired to
   * this callback -- for lists the user owns (free-text asset classes) rather
   * than a canonical list (countries).
   */
  onDeleteOption?: (name: string) => void;
  /** Accessible name for the per-option delete control. */
  deleteOptionAriaLabel?: string;
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
  addRowLabel,
  nameAriaLabel,
  onDeleteOption,
  deleteOptionAriaLabel,
}: AllocationEditorProps) {
  const t = useTranslations('securities');
  const { formatNumber, formatPercent } = useNumberFormat();

  const total = useMemo(
    () => value.reduce((sum, row) => sum + parseWeight(row.weight), 0),
    [value],
  );
  const remainder = roundToDecimals(100 - total, 4);
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
        {title ? (
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {title}
          </span>
        ) : (
          <span />
        )}
        <span
          className={`text-xs font-medium ${
            overAllocated
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-500 dark:text-gray-400'
          }`}
          data-testid="allocation-total"
        >
          {t('form.allocation.total', { total: formatNumber(total, 2) })}
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
                aria-label={nameAriaLabel ?? t('form.allocation.nameAriaLabel')}
                onDeleteOption={
                  onDeleteOption
                    ? (optionValue, label) => onDeleteOption(optionValue || label)
                    : undefined
                }
                deleteOptionAriaLabel={deleteOptionAriaLabel}
              />
            </div>
            <div className="w-28">
              <NumericInput
                decimalPlaces={2}
                min={0}
                max={100}
                value={row.weight === '' ? undefined : parseWeight(row.weight)}
                onChange={(weight) =>
                  updateRow(index, { weight: weight === undefined ? '' : String(weight) })
                }
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
          <span data-testid="allocation-other">{formatPercent(remainder, 2)}</span>
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
        {addRowLabel ?? t('form.allocation.addRow')}
      </button>
    </div>
  );
}
