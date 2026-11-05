'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { toSafeExternalUrl } from '@/lib/external-url';
import type { HeldSeries } from '@/lib/bond-series';
import type { BondValuationTotals } from '@/types/bond';
import { SecurityBondLotsTable } from './SecurityBondLotsTable';
import { SecurityBondPeriodRate } from './SecurityBondPeriodRate';
import { SecurityBondRateSection } from './SecurityBondRateSection';

interface SecurityBondSeriesTableProps {
  series: HeldSeries[];
  /** The program's totals as the server worked them out; each is null unless every lot has it. */
  totals: BondValuationTotals;
  currency: string;
  /** Why a null total is null, said beside it. */
  unknownReason: string;
}

/**
 * "Your series" (spec `bond-program-securities.md` 3.4): one row per series the
 * reader holds, with what the whole holding of that series is worth, and the
 * program's totals under them. A row opens onto the per-lot detail of its
 * series (the lots, the rate schedule with its indexation notice, the interest
 * chart). A figure the server could not work out is unknown, never a zero.
 */
export function SecurityBondSeriesTable({
  series,
  totals,
  currency,
  unknownReason,
}: SecurityBondSeriesTableProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatShareQuantity } = useNumberFormat();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">{t('bond.unknown')}</span>
  );
  // A decimal string is converted only here, at the formatting boundary.
  const money = (value: string | null): ReactNode =>
    value === null ? unknown : formatCurrency(Number(value), currency);
  const totalMoney = (value: string | null): ReactNode =>
    value === null ? (
      <>
        {unknown}
        <span className="block whitespace-normal text-xs font-normal text-gray-500 dark:text-gray-400">
          {unknownReason}
        </span>
      </>
    ) : (
      formatCurrency(Number(value), currency)
    );

  const purchased = (s: HeldSeries): string => {
    const first = s.purchaseDates[0];
    const last = s.purchaseDates[s.purchaseDates.length - 1];
    return s.purchaseDates.length === 1
      ? formatDate(first)
      : t('bond.series.purchasedRange', {
          from: formatDate(first),
          to: formatDate(last),
        });
  };

  const renderRate = (s: HeldSeries): ReactNode => {
    const v = s.latestLot.valuation;
    const period = v.currentPeriod;
    if (period === null) {
      return v.status === 'MATURED' ? (
        <span className="text-gray-500 dark:text-gray-400">{t('bond.lots.matured')}</span>
      ) : (
        unknown
      );
    }
    return <SecurityBondPeriodRate valuation={v} period={period} />;
  };

  const renderTermsSource = (s: HeldSeries): ReactNode => {
    const source = s.series?.termsSource;
    if (!source) return null;
    if (source.provider === 'manual') {
      return (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('bond.termsManual')}</p>
      );
    }
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {/* Only an http(s) address is made a link. */}
        {toSafeExternalUrl(source.url) ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('bond.termsSource', { document: source.document })}
          </a>
        ) : (
          t('bond.termsSource', { document: source.document })
        )}
      </p>
    );
  };

  const columnCount = 9;

  return (
    <div className="overflow-x-auto scrollbar-slim">
      <table className={TABLE_CLASS}>
        <thead>
          <tr>
            <Th>{t('bond.series.column')}</Th>
            <Th align="right">{t('bond.lots.quantity')}</Th>
            <Th>{t('bond.lots.purchaseDate')}</Th>
            <Th align="right">{t('bond.lots.grossValue')}</Th>
            <Th align="right">{t('bond.lots.accruedInterest')}</Th>
            <Th align="right">{t('bond.lots.earlyRedemption')}</Th>
            <Th>{t('bond.lots.rate')}</Th>
            <Th>{t('bond.series.nextRateChange')}</Th>
            <Th>{t('bond.lots.maturity')}</Th>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {series.map((s) => {
            const isOpen = open.has(s.instrumentId);
            const Chevron = isOpen ? ChevronDownIcon : ChevronRightIcon;
            const detailId = `bond-series-${s.instrumentId}`;
            return (
              <Fragment key={s.instrumentId}>
                <tr>
                  <Td className="whitespace-nowrap font-medium">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={detailId}
                      aria-label={t(
                        isOpen ? 'bond.series.collapse' : 'bond.series.expand',
                        { series: s.seriesCode },
                      )}
                      onClick={() => toggle(s.instrumentId)}
                      className="mr-1 inline-flex items-center rounded align-middle text-gray-500 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      <Chevron className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {s.seriesCode}
                    {s.incomplete && (
                      <Badge variant="amber" className="ml-2">
                        {t('bond.series.partial')}
                      </Badge>
                    )}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatShareQuantity(s.quantity)}
                  </Td>
                  <Td>{purchased(s)}</Td>
                  <Td align="right" className="whitespace-nowrap">
                    {money(s.grossValue)}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {money(s.accruedInterest)}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {money(s.earlyRedemptionValue)}
                  </Td>
                  <Td>{renderRate(s)}</Td>
                  <Td>
                    {s.nextRateReset === null ? (
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('bond.lots.noCashFlow')}
                      </span>
                    ) : (
                      formatDate(s.nextRateReset)
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(s.maturityDate)}</Td>
                </tr>
                {isOpen && (
                  <tr id={detailId}>
                    <Td colSpan={columnCount} className="bg-gray-50 dark:bg-gray-900/30">
                      {/* w-0 min-w-full: the detail fills the row but adds nothing to the
                          table's own width, so the chart cannot widen the table it measures. */}
                      <div className="w-0 min-w-full space-y-4">
                        {renderTermsSource(s)}
                        <SecurityBondLotsTable lots={s.lots} currency={currency} />
                        <SecurityBondRateSection
                          lots={s.lots}
                          currency={currency}
                          redemptionTerms={s.series?.redemptionTerms ?? null}
                        />
                      </div>
                    </Td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <Td className="whitespace-nowrap">{t('bond.series.total')}</Td>
            <Td align="right" className="whitespace-nowrap">
              {totals.quantity === null ? (
                <>
                  {unknown}
                  <span className="block whitespace-normal text-xs font-normal text-gray-500 dark:text-gray-400">
                    {unknownReason}
                  </span>
                </>
              ) : (
                formatShareQuantity(totals.quantity)
              )}
            </Td>
            <Td />
            <Td align="right">{totalMoney(totals.grossValue)}</Td>
            <Td align="right">{totalMoney(totals.accruedInterest)}</Td>
            <Td align="right">{totalMoney(totals.earlyRedemptionValue)}</Td>
            <Td colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
