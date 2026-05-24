'use client';

import { useMemo, useState } from 'react';
import {
  INVESTMENT_REPORT_COLUMNS,
  INVESTMENT_COLUMN_MAP,
} from '@/types/investment-report';

interface InvestmentReportColumnChooserProps {
  /** Ordered selected column keys. */
  value: string[];
  onChange: (columns: string[]) => void;
}

/**
 * Lets the user pick which MS Money-style columns appear in the report and the
 * order they appear in. Columns are added from the available list, removed with
 * the ✕, and reordered by dragging.
 */
export function InvestmentReportColumnChooser({
  value,
  onChange,
}: InvestmentReportColumnChooserProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const available = useMemo(
    () => INVESTMENT_REPORT_COLUMNS.filter((c) => !value.includes(c.key)),
    [value],
  );

  const add = (key: string) => onChange([...value, key]);
  const remove = (key: string) => onChange(value.filter((c) => c !== key));

  const handleDrop = (targetIndex: number) => {
    setOverIndex(null);
    const from = dragIndex;
    setDragIndex(null);
    if (from === null || from === targetIndex) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Selected (ordered, drag to reorder) */}
      <div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Selected columns ({value.length})
        </div>
        <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-auto">
          {value.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
              Add at least one column from the list.
            </li>
          )}
          {value.map((key, index) => {
            const col = INVESTMENT_COLUMN_MAP[key];
            return (
              <li
                key={key}
                data-testid={`selected-${key}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overIndex !== index) setOverIndex(index);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(index);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={`flex items-center gap-2 px-3 py-2 text-sm cursor-grab ${
                  dragIndex === index ? 'opacity-50' : ''
                } ${
                  overIndex === index && dragIndex !== null && dragIndex !== index
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : ''
                }`}
              >
                <span aria-hidden="true" className="select-none text-gray-400">
                  ⠿
                </span>
                <span className="flex-1 text-gray-900 dark:text-gray-100">
                  {col?.label ?? key}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${col?.label ?? key}`}
                  onClick={() => remove(key)}
                  className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Drag columns to reorder.
        </p>
      </div>

      {/* Available */}
      <div>
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Available columns ({available.length})
        </div>
        <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-auto">
          {available.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
              All columns selected
            </li>
          )}
          {available.map((col) => (
            <li key={col.key} className="flex items-start gap-2 px-3 py-2 text-sm">
              <button
                type="button"
                aria-label={`Add ${col.label}`}
                onClick={() => add(col.key)}
                className="mt-0.5 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium leading-none"
              >
                +
              </button>
              <div className="flex-1">
                <div className="text-gray-900 dark:text-gray-100">{col.label}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {col.description}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
