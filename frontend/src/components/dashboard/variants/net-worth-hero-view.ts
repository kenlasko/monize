import type { ReactNode } from 'react';
import type { ConvertedTotal } from '@/lib/currency-total';
import type { CollapsedHeaderTitle } from '@/store/mobileChromeStore';
import type { HeroChartPoint } from '../hero-parts';

/** A figure under the headline, marked as a subtotal when it is one. */
export interface NetWorthHeroInvested {
  value: number;
  total: ConvertedTotal;
  /** Why the figure is a subtotal, when the cause is not a missing rate. */
  explanation?: string;
}

/**
 * Everything the net worth set shows, worked out once by `NetWorthHero`. A
 * style's variant only lays it out; it never reads the series itself.
 */
export interface NetWorthHeroViewProps {
  /** The section's accessible name. */
  label: string;
  currency: string;
  netWorth: ConvertedTotal;
  assets: ConvertedTotal;
  liabilities: ConvertedTotal;
  /** `null` when there is nothing invested to show (or it failed to load). */
  invested: NetWorthHeroInvested | null;
  /** The valuation behind "invested" is still on its way. */
  investedLoading: boolean;
  /** What the app header shows once the headline scrolls away. */
  collapsed: CollapsedHeaderTitle;
  /**
   * This month's change: `null` with fewer than two months; `known: false`
   * when either month is a subtotal. `text` is the catalog's sentence, its
   * direction said in words to a screen reader.
   */
  change: { known: true; up: boolean; text: ReactNode } | { known: false } | null;
  /** The monthly series, a month that did not fully convert as `null`. */
  points: HeroChartPoint[];
  formatTick: (key: string) => string;
  formatTooltipKey: (key: string) => string;
  /** A month's one-letter label, for a dense strip of bars. */
  formatNarrowMonth: (key: string) => string;
}
