import type { ReactNode } from 'react';

/** The tone a figure keeps from the report's own cards: gain, loss, or plain ink. */
export type StatementTone = 'gain' | 'loss' | 'plain';

/** One line of the breakdown, already formatted by the report. */
export interface StatementLine {
  key: string;
  label: string;
  /** The figure as the report draws it (a `PartialTotal`, a signed amount). */
  value: ReactNode;
  tone?: StatementTone;
  /** A chart colour (a `chartColors` token or the report's own series colour). */
  swatch?: string;
  /** The line's share of the total, already formatted. */
  share?: string;
  /** Opens the line's drill-down, as its legend entry did. */
  onSelect?: () => void;
  disabled?: boolean;
}

/**
 * What a style's renderer of a report's statement is handed: the figures the
 * report already computed, laid out as a statement (Folio) or colour blocks
 * (Pebble). Nothing is derived here; an unknown figure arrives as whatever the
 * report renders for it.
 */
export interface ReportStatementViewProps {
  /** The statement's accessible name. */
  ariaLabel: string;
  lines: StatementLine[];
  /** The line the schedule adds up to, set under a double rule. */
  total: { label: string; value: ReactNode; tone?: StatementTone };
  /** Figures that are not part of the sum (a rate, a change). */
  memo?: Array<{ key: string; label: string; value: ReactNode; tone?: StatementTone }>;
  /** Show a Share column (lines carry `share`). */
  showShare?: boolean;
}

export const STATEMENT_TONE_CLASS: Record<StatementTone, string> = {
  gain: 'text-green-600 dark:text-green-400',
  loss: 'text-red-600 dark:text-red-400',
  plain: 'text-gray-900 dark:text-gray-100',
};
