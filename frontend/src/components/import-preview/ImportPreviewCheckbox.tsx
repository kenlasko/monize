'use client';

import { useEffect, useRef } from 'react';
import type { CheckState } from '@/lib/import-preview';

export const IMPORT_PREVIEW_CHECKBOX_CLASS =
  'h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed dark:border-gray-600';

interface ImportPreviewCheckboxProps {
  /** Checked for `all`, the browser's indeterminate mark for `some`, empty for `none`. */
  state: CheckState;
  onChange: (checked: boolean) => void;
  /** Names what the box selects for a screen reader. */
  label: string;
  disabled?: boolean;
}

/**
 * The checkbox of an import preview: one row's ("all" or "none") or the
 * header's over many rows (`some` shows the indeterminate mark, and ticking it
 * checks the rest). `indeterminate` is a DOM property with no attribute, so it
 * is written from an effect; nothing in React state depends on it.
 */
export function ImportPreviewCheckbox({ state, onChange, label, disabled = false }: ImportPreviewCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={IMPORT_PREVIEW_CHECKBOX_CLASS}
      checked={state === 'all'}
      onChange={() => onChange(state !== 'all')}
      aria-label={label}
      disabled={disabled}
    />
  );
}
