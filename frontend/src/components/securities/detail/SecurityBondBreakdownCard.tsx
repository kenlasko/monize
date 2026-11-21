'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Button } from '@/components/ui/Button';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import {
  breakdownByMaturityYear,
  breakdownBySeries,
  breakdownShares,
  type BondBreakdownRow,
} from '@/lib/bond-breakdown';
import { BOND_OFFER_COUNTRY } from '@/lib/bond-offer';
import { groupLotsBySeries, programFacts } from '@/lib/bond-series';
import { chartColors } from '@/lib/chart-colors';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import type { BondOffer, SecurityBondValuation } from '@/types/bond';
import { bondCountryName } from '../BondProgramSelect';
import { rateRuleLines } from './bond-labels';

interface SecurityBondBreakdownCardProps {
  security: Security;
  /**
   * Bumped by the page each time a price refresh completes (whatever its
   * outcome): the bond data the refresh fetched is re-read once, in place.
   */
  refreshVersion?: number;
}

const TABS = ['series', 'maturity'] as const;
type BondTab = (typeof TABS)[number];

/**
 * The Breakdown card of a program-linked security: the sector, country and asset
 * class splits mean nothing for a bond kind, so it shows what the reader holds of
 * it by series and by maturity year, and what the kind is (issuer country, rate,
 * interest, term), which stays when nothing is held.
 *
 * The holdings come from the same endpoint as the bond card (today's valuation,
 * no scenario assumption), read here on its own because the bond card keeps its
 * valuation private and keyed to the day and scenario the reader picked.
 *
 * Shares are drawn only over a complete set of values: when any series is
 * unknown the known rows keep their values and the card says some are unknown.
 */
export function SecurityBondBreakdownCard({
  security,
  refreshVersion = 0,
}: SecurityBondBreakdownCardProps) {
  const t = useTranslations('securityDetail');
  const tBonds = useTranslations('bonds');
  const locale = useLocale();
  const today = useFinancialToday();
  const { formatCurrency, formatPercent, formatPercentTrimmed } = useNumberFormat();
  const [tab, setTab] = useState<BondTab>('series');
  const currency = security.currencyCode;

  const requestKey = `${security.id}|${today}`;
  const valuationRequest = useReportData<SecurityBondValuation>(
    () => investmentsApi.getSecurityBondValuation(security.id, today),
    [security.id, today, refreshVersion],
    { requestKey },
  );
  const valuation =
    valuationRequest.data !== null && valuationRequest.dataKey === requestKey
      ? valuationRequest.data
      : null;

  const countryCode = valuation?.program.issuerCountryCode ?? BOND_OFFER_COUNTRY;
  const offer = useReportData<BondOffer>(
    () => investmentsApi.getBondOffer(countryCode),
    [countryCode, refreshVersion],
  );

  const held = useMemo(
    () => (valuation ? groupLotsBySeries(valuation) : []),
    [valuation],
  );
  const rowsByTab = useMemo<Record<BondTab, BondBreakdownRow[]>>(
    () => ({
      series: breakdownBySeries(held),
      maturity: breakdownByMaturityYear(held),
    }),
    [held],
  );

  const facts = valuation
    ? programFacts(offer.data?.series ?? [], held, valuation.program.programCode)
    : null;
  // Rates are fractions; the formatter takes percent units.
  const pct = (fraction: string) => formatPercentTrimmed(Number(fraction) * 100);
  const unknown = t('bond.unknown');

  const renderRows = (rows: BondBreakdownRow[]) => {
    if (rows.length === 0) {
      return (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('weightings.bond.empty')}
        </p>
      );
    }
    const { complete, shares } = breakdownShares(rows);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ul className="scrollbar-slim max-h-56 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {rows.map((row) => {
            const share = shares.get(row.key);
            const money =
              row.value === null ? unknown : formatCurrency(row.value, currency);
            const percent = share === undefined ? null : formatPercent(share);
            return (
              <li key={row.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm text-gray-700 dark:text-gray-300">
                    {row.label}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
                    {percent === null ? money : `${money} (${percent})`}
                  </span>
                </div>
                {percent !== null && share !== undefined && (
                  <div
                    className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
                    role="img"
                    aria-label={`${row.label}: ${percent}`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(share, 0.5)}%`,
                        backgroundColor: chartColors.primary,
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!complete && (
          <p role="note" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t('weightings.bond.someUnknown')}
          </p>
        )}
      </div>
    );
  };

  const fact = (label: string, value: ReactNode) => (
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );

  const renderFacts = () => {
    if (!valuation) return null;
    const ruleLines = facts ? rateRuleLines(t, facts.rateRule, pct) : [];
    const interest =
      facts === null || facts.capitalization === null
        ? unknown
        : facts.periodMonths === null
          ? tBonds(`offer.capitalization.${facts.capitalization}`)
          : t('weightings.bond.interestValue', {
              capitalization: tBonds(`offer.capitalization.${facts.capitalization}`),
              period: tBonds('offer.lengthValue', { months: facts.periodMonths }),
            });
    return (
      <dl className="mt-4 shrink-0 space-y-2 border-t border-gray-200 pt-3 dark:border-gray-700">
        {fact(
          t('weightings.bond.issuerCountry'),
          bondCountryName(valuation.program.issuerCountryCode, locale),
        )}
        {fact(
          t('weightings.bond.rate'),
          facts === null ? (
            unknown
          ) : (
            <>
              <p>{t(`weightings.bond.rateType.${facts.rateRule.type}`)}</p>
              {ruleLines.map((line) => (
                <p key={line} className="text-xs text-gray-500 dark:text-gray-400">
                  {line}
                </p>
              ))}
            </>
          ),
        )}
        {fact(t('weightings.bond.interest'), interest)}
        {fact(
          t('weightings.bond.term'),
          facts === null || facts.lengthMonths === null
            ? unknown
            : tBonds('offer.lengthValue', { months: facts.lengthMonths }),
        )}
      </dl>
    );
  };

  const renderBody = () => {
    if (valuationRequest.error) {
      return (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(valuationRequest.error, t('bond.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={valuationRequest.reload}>
            {t('error.retry')}
          </Button>
        </div>
      );
    }
    if (!valuation) {
      return (
        <div className="flex justify-center py-4">
          <LoadingSpinner text={t('bond.loading')} />
        </div>
      );
    }
    return (
      <>
        <Tabs
          tabs={TABS.map((key) => ({
            key,
            label: t(`weightings.bond.${key}Tab`),
          }))}
          value={tab}
          onChange={setTab}
          idPrefix="securityBreakdown"
          ariaLabel={t('weightings.ariaLabel')}
          className="shrink-0"
        />
        {TABS.map((key) => (
          <TabPanel
            key={key}
            idPrefix="securityBreakdown"
            tabKey={key}
            isActive={tab === key}
            className="mt-3 flex min-h-0 flex-1 flex-col"
          >
            {renderRows(rowsByTab[key])}
          </TabPanel>
        ))}
        {renderFacts()}
      </>
    );
  };

  return (
    <div className={`${CARD_CLASS} flex min-h-0 flex-1 flex-col p-4`}>
      <h3 className="mb-3 shrink-0 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('weightings.title')}
      </h3>
      {renderBody()}
    </div>
  );
}
