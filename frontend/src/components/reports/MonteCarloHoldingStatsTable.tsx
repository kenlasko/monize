'use client';

import { AccountHoldingStats } from '@/lib/monte-carlo';
import { useTranslations } from 'next-intl';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { NumberFormatters } from '@/hooks/useNumberFormat';
import { CAPTION_CLASS, CellLabel, Th } from '@/components/ui/Table';

// A money (or percentage) cell inside a wrapped row: no padding of its own
// below `sm` (the row supplies it and the grid does the spacing), this table's
// own `px-3 py-1.5` from `sm` up. The text size inherits `text-xs` from the
// table element at every width, so there is no per-cell size to preserve.
// `whitespace-nowrap` is not phone-only: a locale grouping thousands with a
// space could otherwise break a figure in the middle, at any width. A number
// must not break; the caption inside takes `whitespace-normal` back (CellLabel).
const FIGURE_CELL = 'p-0 text-right whitespace-nowrap sm:table-cell sm:px-3 sm:py-1.5';

export function HoldingStatsTable({
  data,
  loading,
  formatters,
}: {
  data: AccountHoldingStats[] | null;
  loading: boolean;
  // `formatCurrency` takes the value's own currency code. The market value is in
  // the security's native currency, and formatting it with the default-currency
  // symbol printed a USD holding as "1,000 PLN" -- a money value and its
  // currency are one tuple (recheck RR5-004). The percentages travel with it
  // because they are read by the same person in the same number locale.
  formatters: NumberFormatters;
}) {
  const t = useTranslations('reports');
  const { formatCurrency, formatPercent } = formatters;

  if (loading) {
    return (
      <div className="mb-3 text-xs">
        <LoadingSpinner size="sm" fullContainer={false} text={t('monteCarloHoldingStats.loading')} />
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        {t('monteCarloHoldingStats.selectAccounts')}
      </p>
    );
  }

  const fmtPct = (v: number | null) =>
    v == null ? '—' : formatPercent(v * 100, 2);

  // A missing current price is unknown, not zero. Formatting `null` as currency
  // would print the locale's zero and claim the position is worthless. A present
  // value is formatted in the holding's OWN currency (recheck RR5-004).
  const fmtValue = (v: number | null, currencyCode: string | null) =>
    v == null || !currencyCode ? '—' : formatCurrency(v, currencyCode);

  return (
    <div className="space-y-3 mb-3">
      {data.map((acct) => (
        <div
          key={acct.accountId}
          className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden"
        >
          <div className="bg-gray-50 dark:bg-gray-900/50 px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {acct.accountName}{' '}
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              ({acct.currencyCode})
            </span>
          </div>
          {acct.holdings.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              {t('monteCarloHoldingStats.noHoldings')}
            </div>
          ) : (
            // Below `sm` the table becomes a block and each row wraps into a
            // two-track grid card so all five columns fit a phone without a
            // horizontal scroll: line 1 is the symbol (the row identity) and the
            // market value (the headline); line 2 is the security name, spanning
            // both tracks; line 3 is the mean return and the volatility. Nothing
            // is dropped -- the name that today hides below `sm` returns as the
            // card's descriptor -- and no figure wraps (`FIGURE_CELL`). From `sm`
            // up it is the ordinary table, each cell restoring its own
            // `px-3 py-1.5` and the name its `truncate max-w-[200px]`, resolving
            // to today's output in every respect but one: `FIGURE_CELL`'s
            // `whitespace-nowrap` is unprefixed, so it applies there as well,
            // where the base cell carried no `white-space` class. That is
            // deliberate and the constant says why (the symbol cell carries the
            // same class inline, for the same reason).
            // This table's header is not sortable, so below
            // `sm` the column header row is simply block-hidden and every bare
            // figure carries a `CellLabel` naming its column; the symbol and the
            // name name themselves. Restyling `display` strips the implicit table
            // semantics, so the ARIA roles are restated.
            <div className="overflow-x-auto">
              <table role="table" className="block min-w-full text-xs sm:table">
                <thead
                  role="rowgroup"
                  className="hidden bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400 sm:table-header-group"
                >
                  <tr role="row">
                    <Th role="columnheader" className="px-3 py-1.5">{t('monteCarloHoldingStats.colSymbol')}</Th>
                    <Th role="columnheader" className="px-3 py-1.5">
                      {t('monteCarloHoldingStats.colName')}
                    </Th>
                    <Th role="columnheader" align="right" className="px-3 py-1.5">{t('monteCarloHoldingStats.colValue')}</Th>
                    <Th role="columnheader" align="right" className="px-3 py-1.5 whitespace-nowrap">
                      {t('monteCarloHoldingStats.colMean')}
                    </Th>
                    <Th role="columnheader" align="right" className="px-3 py-1.5">
                      {t('monteCarloHoldingStats.colVolatility')}
                    </Th>
                  </tr>
                </thead>
                <tbody
                  role="rowgroup"
                  className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group"
                >
                  {acct.holdings.map((h) => (
                    <tr
                      key={`${acct.accountId}-${h.symbol}`}
                      role="row"
                      className="grid grid-cols-2 items-start gap-x-3 gap-y-1 px-3 py-2 sm:table-row sm:p-0"
                    >
                      {/* Symbol: the row identity, so it carries no caption. */}
                      <td role="cell" className="col-start-1 row-start-1 p-0 font-mono text-gray-900 dark:text-gray-100 whitespace-nowrap sm:table-cell sm:px-3 sm:py-1.5">
                        {h.symbol}
                      </td>
                      {/* Name: the descriptor under the symbol identity, so no
                          caption. It wraps on a phone and keeps its desktop
                          `truncate max-w-[200px]` from `sm` up. */}
                      <td role="cell" className="col-start-1 col-span-2 row-start-2 p-0 text-gray-700 dark:text-gray-300 break-words sm:table-cell sm:px-3 sm:py-1.5 sm:truncate sm:max-w-[200px] sm:break-normal">
                        {h.name}
                      </td>
                      {/* Market value: the headline, beside the symbol. */}
                      <td role="cell" className={`col-start-2 row-start-1 text-gray-700 dark:text-gray-300 ${FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{t('monteCarloHoldingStats.colValue')}</CellLabel>
                        {fmtValue(h.marketValue, h.currencyCode)}
                      </td>
                      <td role="cell" className={`col-start-1 row-start-3 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{t('monteCarloHoldingStats.colMean')}</CellLabel>
                        {fmtPct(h.meanReturn)}
                      </td>
                      <td role="cell" className={`col-start-2 row-start-3 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{t('monteCarloHoldingStats.colVolatility')}</CellLabel>
                        {fmtPct(h.volatility)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
