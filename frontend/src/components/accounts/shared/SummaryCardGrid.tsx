import { ReactNode } from 'react';
import { CARD_CLASS } from '@/components/ui/Card';

export interface SummaryCardItem {
  /** Card label (e.g. "Current Balance"). */
  label: string;
  /** Primary value (already formatted). */
  value: ReactNode;
  /** Optional secondary line under the value. */
  note?: ReactNode;
  /** Tailwind text-colour classes for the value; defaults to neutral. */
  valueClass?: string;
  /** Accessible label override for the card article. Defaults to `label`. */
  ariaLabel?: string;
  /** When set, the card becomes a button (e.g. to drill into transactions). */
  onClick?: () => void;
  /**
   * Small decorative glyph shown before the label. Purely visual -- the label
   * already names the figure -- so it is hidden from assistive tech.
   */
  icon?: ReactNode;
  /**
   * Replaces the label/value/note body entirely, for a card that is a small
   * list rather than a single figure (the detail page's "Held in accounts").
   * The card keeps its shared chrome either way.
   */
  body?: ReactNode;
  /** Extra classes for this card, e.g. a wider `col-span` on desktop. */
  className?: string;
  /**
   * The row's headline figure: the accent block in Pebble, a heavier rule in
   * Folio, unchanged in Standard (`ui-stat-lead`). One per row at most.
   */
  lead?: boolean;
}

interface SummaryCardGridProps {
  cards: SummaryCardItem[];
  /**
   * Tailwind grid-column classes. Defaults to the loan detail page's 2/3/6
   * responsive layout; per-type views pass their own column counts.
   */
  className?: string;
}

/** Default responsive grid, matching the original loan summary card row. */
export const DEFAULT_SUMMARY_GRID = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4';

/**
 * Written out rather than interpolated: Tailwind scans source text for class
 * names, so `lg:grid-cols-${n}` would compile to nothing.
 */
const LG_COLUMNS = [
  '',
  'lg:grid-cols-1',
  'lg:grid-cols-2',
  'lg:grid-cols-3',
  'lg:grid-cols-4',
  'lg:grid-cols-5',
  'lg:grid-cols-6',
  'lg:grid-cols-7',
  'lg:grid-cols-8',
] as const;

/** Past this the cards are too narrow to read, so the row is allowed to wrap. */
const MAX_SINGLE_ROW_CARDS = LG_COLUMNS.length - 1;

/**
 * A grid sized to the cards it holds, so a summary row lands on one line
 * instead of leaving a short second row hanging beneath it. Several of these
 * rows vary in length with the account -- a chequing account shows five cards,
 * six once it has an interest rate, seven once that rate has earned something
 * -- and a fixed column count cannot fit all three.
 *
 * Below `lg` the row still wraps: two columns on a phone and three on a tablet
 * are as many cards as fit before the amounts start truncating.
 */
export function summaryGridClass(cardCount: number): string {
  const count = Math.max(1, Math.min(cardCount, MAX_SINGLE_ROW_CARDS));
  return `grid grid-cols-2 md:grid-cols-3 ${LG_COLUMNS[count]} gap-4`;
}

/**
 * A responsive row of key-figure cards (label / value / optional note),
 * generalised from `LoanSummaryCards` so every account detail view shares the
 * same card styling. Purely presentational -- callers format the values.
 */
export function SummaryCardGrid({ cards, className = DEFAULT_SUMMARY_GRID }: SummaryCardGridProps) {
  return (
    <div className={className}>
      {cards.map((card, index) => {
        const label = (
          <div className="ui-stat-label flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {card.icon && (
              <span aria-hidden="true" className="ui-stat-icon shrink-0">
                {card.icon}
              </span>
            )}
            <span>{card.label}</span>
          </div>
        );
        const body = card.body ? (
          <>
            {label}
            {card.body}
          </>
        ) : (
          <>
            {label}
            <div className={`ui-stat-value text-lg font-bold ${card.valueClass ?? 'text-gray-900 dark:text-gray-100'}`}>
              {card.value}
            </div>
            {card.note != null && card.note !== '' && (
              <div className="ui-stat-hint text-xs text-gray-500 dark:text-gray-400 mt-0.5">{card.note}</div>
            )}
          </>
        );
        const base = `ui-stat${card.lead ? ' ui-stat-lead' : ''} ${CARD_CLASS} p-4 ${card.className ?? ''}`;
        return card.onClick ? (
          <button
            key={`${card.label}-${index}`}
            type="button"
            aria-label={card.ariaLabel ?? card.label}
            onClick={card.onClick}
            className={`${base} text-left w-full hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}
          >
            {body}
          </button>
        ) : (
          <article
            key={`${card.label}-${index}`}
            aria-label={card.ariaLabel ?? card.label}
            className={base}
          >
            {body}
          </article>
        );
      })}
    </div>
  );
}
