'use client';

import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { BillsOutlookFolio } from './BillsOutlookFolio';
import { BillsOutlookPebble } from './BillsOutlookPebble';
import type { BillsOutlookProps } from './bills-outlook-view';

// Standard has no outlook band: the forecast chart and the list say it.
const VARIANTS: StyleVariants<BillsOutlookProps> = {
  standard: () => null,
  folio: BillsOutlookFolio,
  pebble: BillsOutlookPebble,
};

/** The band above the Bills page's forecast, for the styles that draw one. */
export function BillsOutlook(props: BillsOutlookProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}
