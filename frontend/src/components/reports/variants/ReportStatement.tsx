'use client';

import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { ReportStatementFolio } from './ReportStatementFolio';
import { ReportStatementPebble } from './ReportStatementPebble';
import type { ReportStatementViewProps } from './report-statement-view';

const VARIANTS: StyleVariants<ReportStatementViewProps> = {
  standard: () => null,
  folio: ReportStatementFolio,
  pebble: ReportStatementPebble,
};

/**
 * The statement a report offers in Folio and Pebble. Standard draws nothing
 * here: the report keeps its own summary cards and legend, and asks
 * `useReportStatement()` whether to hand them over.
 */
export function ReportStatement(props: ReportStatementViewProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}

/** Whether the active style lays a report's figures out as a statement. */
export function useReportStatement(): boolean {
  return useUiStyle() !== 'standard';
}
