import { ReactNode } from 'react';

export interface KeyValueRow {
  /** Stable identifier; not shown. */
  key: string;
  label: string;
  /**
   * The value. A row whose value is null, undefined or an empty string is
   * dropped entirely -- an empty field says nothing, and a column of dashes
   * reads as broken data rather than as "not supplied".
   */
  value: ReactNode;
}

interface KeyValueListProps {
  rows: readonly KeyValueRow[];
  /**
   * Layout for the label/value pair. `rows` puts the value hard right (the Key
   * information card); `pairs` keeps it next to its label in a two-column grid,
   * which reads better inside a wide card (the About card).
   */
  variant?: 'rows' | 'pairs';
  className?: string;
}

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * A label/value list, the shape every "details" panel in the app draws by hand.
 * Introduced with the security detail page, whose Key information, About and
 * Position info cards are all this list with different rows.
 *
 * Uses a real `<dl>` so the pairing is in the markup rather than implied by
 * columns, and skips empty rows so a sparsely-filled security shows a short
 * list instead of a long one full of blanks.
 */
export function KeyValueList({
  rows,
  variant = 'rows',
  className = '',
}: KeyValueListProps) {
  const visibleRows = rows.filter((row) => !isEmpty(row.value));
  if (visibleRows.length === 0) return null;

  return (
    <dl className={`ui-kv space-y-2 ${className}`}>
      {visibleRows.map((row) => (
        <div
          key={row.key}
          className={
            variant === 'rows'
              ? 'ui-kv-row flex items-baseline justify-between gap-4'
              : 'ui-kv-row grid grid-cols-[minmax(6rem,auto)_1fr] items-baseline gap-x-4 gap-y-1'
          }
        >
          <dt className="ui-kv-label text-sm text-gray-500 dark:text-gray-400">
            {row.label}
          </dt>
          <dd
            className={`ui-kv-value text-sm text-gray-900 dark:text-gray-100 ${
              variant === 'rows' ? 'text-right' : ''
            }`}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
