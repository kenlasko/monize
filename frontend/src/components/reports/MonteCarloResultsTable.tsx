'use client';

import { CashFlowEvent, CashFlowLegendSwatch } from './MonteCarloChartParts';
import { useTranslations } from 'next-intl';
import { CAPTION_CLASS, CellLabel, Th } from '@/components/ui/Table';
import { gainLossColor } from '@/lib/format';
import { CARD_CLASS } from '@/components/ui/Card';

export function SummaryStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`${CARD_CLASS} p-4 ${className ?? ''}`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 break-words">
        {value}
      </div>
    </div>
  );
}

// A money cell inside a wrapped row: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), this table's own `px-3 py-1.5`
// from `sm` up. The text size inherits `text-xs` from the table element at
// every width, so there is no per-cell size to preserve. `whitespace-nowrap`
// is the one property that is NOT phone-only: a locale grouping thousands with
// a space could otherwise break a figure in the middle, at any width. A number
// must not break; the caption inside takes `whitespace-normal` back (CellLabel).
const MONEY_CELL = 'p-0 text-right whitespace-nowrap sm:table-cell sm:px-3 sm:py-1.5';

export function ResultsTable({
  rows,
  formatCurrency,
}: {
  rows: Array<{
    year: string;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    events: CashFlowEvent[];
  }>;
  formatCurrency: (v: number) => string;
}) {
  const t = useTranslations('reports');
  return (
    // Below `sm` the table becomes a block and each row wraps into a two-track
    // grid card so all seven columns fit a phone without a horizontal scroll:
    // line 1 is the year (the row identity) and the median (the headline
    // percentile); lines 2 and 3 carry the four remaining percentiles two to a
    // line; line 4 is the year's cash-flow events, spanning both tracks. Nothing
    // is dropped, and no money figure wraps (`MONEY_CELL`). From `sm` up it is
    // the ordinary table, each cell restoring its own `px-3 py-1.5` and the
    // table's `text-xs` inherited at every width, so at 640px+ it resolves to
    // today's output in every respect but one: `MONEY_CELL`'s
    // `whitespace-nowrap` is unprefixed, so it applies there as well, where the
    // base cell carried no `white-space` class. That is deliberate and the
    // constant says why. This table's header is not sortable, so below `sm` the
    // column header row is simply block-hidden and every bare figure carries a
    // `CellLabel` naming its column; the year names itself. Restyling `display`
    // strips the implicit table semantics, so the ARIA roles are restated. The
    // phone grid places cells out of DOM order, which stays the desktop column
    // order.
    <div className="overflow-x-auto">
      <table role="table" className="block min-w-full text-xs sm:table">
        <thead
          role="rowgroup"
          className="hidden bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 sm:table-header-group"
        >
          <tr role="row">
            <Th role="columnheader" className="px-3 py-2">{t('monteCarloResults.colYear')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloResults.col10th')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloResults.col25th')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloResults.colMedian')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloResults.col75th')}</Th>
            <Th role="columnheader" align="right" className="px-3 py-2">{t('monteCarloResults.col90th')}</Th>
            <Th role="columnheader" className="px-3 py-2">{t('monteCarloResults.colEvents')}</Th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group"
        >
          {rows.map((r) => (
            <tr
              key={r.year}
              role="row"
              className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-3 py-2 sm:table-row sm:p-0"
            >
              {/* Year: the row identity, so it carries no caption. */}
              <td role="cell" className="col-start-1 row-start-1 p-0 font-mono text-gray-900 dark:text-gray-100 sm:table-cell sm:px-3 sm:py-1.5">
                {r.year}
              </td>
              <td role="cell" className={`col-start-1 row-start-2 ${MONEY_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.col10th')}</CellLabel>
                {formatCurrency(r.p10)}
              </td>
              <td role="cell" className={`col-start-2 row-start-2 ${MONEY_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.col25th')}</CellLabel>
                {formatCurrency(r.p25)}
              </td>
              {/* Median: the headline percentile, beside the year. */}
              <td role="cell" className={`col-start-2 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.colMedian')}</CellLabel>
                {formatCurrency(r.p50)}
              </td>
              <td role="cell" className={`col-start-1 row-start-3 ${MONEY_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.col75th')}</CellLabel>
                {formatCurrency(r.p75)}
              </td>
              <td role="cell" className={`col-start-2 row-start-3 ${MONEY_CELL}`}>
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.col90th')}</CellLabel>
                {formatCurrency(r.p90)}
              </td>
              {/* Events span both tracks on their own line; the list wraps. */}
              <td role="cell" className="col-start-1 col-span-2 row-start-4 p-0 sm:table-cell sm:px-3 sm:py-1.5">
                <CellLabel className={CAPTION_CLASS}>{t('monteCarloResults.colEvents')}</CellLabel>
                {r.events.length === 0 ? (
                  <span className="text-gray-400 dark:text-gray-500">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {r.events.map((e, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 ${gainLossColor(e.income ? 1 : -1)}`}
                      >
                        <CashFlowLegendSwatch role={e.role} income={e.income} />
                        {e.flowType === 'ONE_TIME'
                          ? e.name
                          : `${e.role === 'start' ? t('monteCarloResults.starts') : t('monteCarloResults.ends')}: ${e.name}`}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
