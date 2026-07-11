'use client';

import { useState } from 'react';

interface RateCellProps {
  annualRate: number | null;
  /** When false the rate is shown read-only (no inline editing). */
  editable: boolean;
  saving: boolean;
  onCommit: (annualRate: number) => void;
  editLabel: string;
}

/**
 * A schedule-row rate: read-only text, or (when editable) a click-to-edit
 * number field that commits the new annual rate on Enter/blur. Escape or an
 * unchanged/invalid value cancels without a write.
 */
export function RateCell({
  annualRate,
  editable,
  saving,
  onCommit,
  editLabel,
}: RateCellProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const display = annualRate != null ? `${annualRate.toFixed(2)}%` : '—';

  if (!editable) {
    return <span className="text-gray-500 dark:text-gray-400">{display}</span>;
  }

  if (draft === null) {
    return (
      <button
        type="button"
        aria-label={editLabel}
        disabled={saving}
        onClick={() => setDraft(annualRate != null ? String(annualRate) : '')}
        className="text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 underline decoration-dotted underline-offset-2 disabled:opacity-50"
      >
        {saving ? '…' : display}
      </button>
    );
  }

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    setDraft(null);
    if (
      Number.isFinite(parsed) &&
      parsed >= 0 &&
      parsed <= 100 &&
      parsed !== annualRate
    ) {
      onCommit(parsed);
    }
  };

  return (
    <input
      type="number"
      step="0.01"
      min="0"
      max="100"
      autoFocus
      aria-label={editLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
      className="w-20 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-1.5 py-0.5 text-right text-sm"
    />
  );
}
