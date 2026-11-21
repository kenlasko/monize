import type { ReactNode } from 'react';
import type { ScheduledKind } from '@/lib/scheduled-kind';

/**
 * One occurrence in the Upcoming Bills list, as every style draws it. The
 * owner (`UpcomingBills`) derives all of it -- which occurrence, its amount,
 * its kind, whether it overdraws its account -- so a style only lays it out.
 */
export interface UpcomingBillRow {
  id: string;
  name: string;
  payee: string | null;
  /** The occurrence's own due date (`nextOccurrenceDueDate`), `YYYY-MM-DD`. */
  dueDate: string;
  overdue: boolean;
  /** "Overdue", "Today", "3 days" or a date. */
  dueLabel: string;
  /** The due-date chip's colours (Standard). */
  dueClass: string;
  kind: ScheduledKind;
  /** The kind as a small badge (Standard). */
  typeBadge: ReactNode;
  /** The signed, formatted amount; `null` when it cannot be worked out. */
  amountText: string | null;
  amountClass: string;
  manual: boolean;
  /** The amount follows the history estimate. */
  estimated: boolean;
  /** Posting it takes its account below zero. */
  overdraws: boolean;
}

/** One occurrence placed on the two-week strip. */
export interface UpcomingStripItem {
  id: string;
  name: string;
  kind: ScheduledKind;
  payee: string | null;
  /** The occurrence's magnitude, `null` when unknown. */
  magnitude: number | null;
  /** The currency `magnitude` is in. */
  currencyCode: string;
}

/** One day of the two weeks starting today. */
export interface UpcomingStripDay {
  /** `YYYY-MM-DD`. */
  date: string;
  isToday: boolean;
  items: UpcomingStripItem[];
}

export interface UpcomingStrip {
  days: UpcomingStripDay[];
  /**
   * The largest magnitude on the strip, when every known amount on it is in
   * one currency: bars are then drawn to scale. `null` otherwise, and the
   * bars are drawn at one height, saying only which way the money goes --
   * amounts in two currencies are not comparable without a rate.
   */
  scaleMax: number | null;
}

export interface UpcomingBillsListProps {
  rows: UpcomingBillRow[];
  /** Occurrences in scope beyond the ones listed. */
  hiddenCount: number;
  strip: UpcomingStrip;
  onOpen: (id: string) => void;
  onShowAll: () => void;
}

/**
 * A strip bar's height in px: to scale against the largest magnitude on the
 * strip, or a fixed height when the strip cannot be scaled (mixed currencies,
 * an unknown amount). Each strip passes its own sizes.
 */
export function stripBarHeight(
  item: UpcomingStripItem,
  scaleMax: number | null,
  maxPx: number,
  unscaledPx: number,
): number {
  if (scaleMax === null || item.magnitude === null || scaleMax === 0) return unscaledPx;
  return Math.max(3, Math.round((item.magnitude / scaleMax) * maxPx));
}

