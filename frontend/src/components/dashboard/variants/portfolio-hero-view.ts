import type { ReactNode } from 'react';
import type { ConvertedTotal } from '@/lib/currency-total';
import type { CollapsedHeaderTitle } from '@/store/mobileChromeStore';

/** The portfolio's change over the window, as the set shows it beside the headline. */
export type PortfolioHeroChange =
  /** A measured change; `text` is the catalog's sentence, its direction said in words. */
  | { kind: 'known'; up: boolean; text: ReactNode }
  /** Withheld, or a request that failed: the cause, in no colour. */
  | { kind: 'unknown'; text: ReactNode }
  /** On its way: the place the figure will take. */
  | { kind: 'pending' };

/**
 * Everything the portfolio set shows, worked out once by `PortfolioHero`. A
 * style's variant only lays it out, as it does for `NetWorthHeroViewProps`, so
 * the two sets are typeset alike in every style.
 */
export interface PortfolioHeroViewProps {
  /** The section's accessible name. */
  label: string;
  currency: string;
  /** "Portfolio value (accounts)", the accounts keeping their own case. */
  caption: ReactNode;
  /** The chosen accounts' value; a subtotal while a price or a rate is missing. */
  total: ConvertedTotal | null;
  /** What the app header shows once the headline scrolls away. */
  collapsed: CollapsedHeaderTitle;
  /** `null` when there is nothing to measure it against. */
  change: PortfolioHeroChange | null;
  holdings: ConvertedTotal | null;
  cash: ConvertedTotal | null;
  /**
   * What stands where a figure above is `null` (withheld outright): that figure's
   * own reason, as `UnknownAmount` draws it. The rest of the set still shows.
   */
  unknown: { total: ReactNode; holdings: ReactNode; cash: ReactNode };
  /**
   * The chosen figure: `name` reads inside a sentence, `label` over an amount,
   * and `value` is its figure, a placeholder or the reason it is withheld.
   */
  metric: { name: string; label: string; value: ReactNode };
  /** The value chart, or what stands in its place (loading, failed, no intraday prices). */
  chart: ReactNode;
}
