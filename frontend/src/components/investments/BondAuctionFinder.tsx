'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { BondAuction, BondAuctions } from '@/types/bond';
import type { BondSeriesOptions } from './BondSeriesSelect';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_DECIMALS = 3;
const PRICE_DECIMALS = 6;
const ALL_TERMS = '';

interface Listed {
  /** The security and date the list was asked for: a list is shown only for its own. */
  key: string;
  date: string;
  result: BondAuctions;
}

interface BondAuctionFinderProps {
  securityId: string;
  /** The form's trade date, YYYY-MM-DD. */
  date: string;
  series: BondSeriesOptions;
  /** The series chosen (stored or just fetched) and the auction it came from. */
  onPick: (instrumentId: string, auction: BondAuction) => void;
}

/**
 * The auctions of a program that sells by auction, around the form's date, for
 * a person to say which one the purchase was (`docs/specs/us-treasury-securities.md`
 * section 11). Asked only when the person clicks: the list is read from the
 * issuer's site. Choosing a held auction selects its series, fetching it first
 * when the catalog does not hold it.
 */
export function BondAuctionFinder({ securityId, date, series, onPick }: BondAuctionFinderProps) {
  const t = useTranslations('investments');
  const { formatDate } = useDateFormat();
  const { formatPercent, formatNumber } = useNumberFormat();
  const [listed, setListed] = useState<Listed | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [term, setTerm] = useState(ALL_TERMS);
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // Set synchronously, so two clicks in one tick cannot both send.
  const inFlight = useRef(false);

  const validDate = DATE_RE.test(date);
  const key = `${securityId}|${date}`;
  const current = listed?.key === key ? listed : null;
  const loading = loadingKey === key;
  const failed = failedKey === key && current === null;

  const find = async () => {
    if (!validDate || loadingKey === key) return;
    setLoadingKey(key);
    setFailedKey(null);
    setPickError(null);
    try {
      const result = await investmentsApi.getBondAuctions(securityId, date);
      setListed({ key, date, result });
      setTerm(ALL_TERMS);
    } catch {
      setFailedKey(key);
    } finally {
      setLoadingKey((k) => (k === key ? null : k));
    }
  };

  const pick = async (auction: BondAuction) => {
    if (inFlight.current || auction.announced || current === null) return;
    setPickError(null);
    if (auction.instrumentId !== null) {
      onPick(auction.instrumentId, auction);
      return;
    }
    inFlight.current = true;
    setPicking(auction.seriesCode);
    try {
      const fetched = await investmentsApi.fetchBondSeries(
        current.result.countryCode,
        auction.seriesCode,
      );
      series.addInstrument(fetched);
      onPick(fetched.id, auction);
    } catch (err) {
      setPickError(getErrorMessage(err, t('transactionForm.bondAuctions.fetchFailed')));
    } finally {
      inFlight.current = false;
      setPicking(null);
    }
  };

  const auctions = useMemo(() => current?.result.auctions ?? [], [current]);
  // The terms in the list, shortest first (by the earliest maturity of each).
  const terms = useMemo(() => {
    const firstMaturity = new Map<string, string>();
    for (const a of auctions) {
      const known = firstMaturity.get(a.term);
      if (known === undefined || a.maturityDate < known) firstMaturity.set(a.term, a.maturityDate);
    }
    return [...firstMaturity.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([name]) => name);
  }, [auctions]);
  const shown = term === ALL_TERMS ? auctions : auctions.filter((a) => a.term === term);

  const rateText = (a: BondAuction): string | null => {
    if (a.ratePercent === null) return null;
    const rate = formatPercent(Number(a.ratePercent), RATE_DECIMALS);
    switch (a.rateKind) {
      case 'DISCOUNT':
        return t('transactionForm.bondAuctions.discountRate', { rate });
      case 'SPREAD':
        return t('transactionForm.bondAuctions.spread', { rate });
      case 'COUPON':
        return t('transactionForm.bondAuctions.coupon', { rate });
    }
  };

  // The held auction's rate and price; the catalog composes the punctuation.
  const resultText = (rate: string | null, pricePer100: string | null): string => {
    const price =
      pricePer100 === null ? null : formatNumber(Number(pricePer100), PRICE_DECIMALS);
    if (rate !== null && price !== null) {
      return t('transactionForm.bondAuctions.rateAndPrice', { rate, price });
    }
    if (price !== null) return t('transactionForm.bondAuctions.price', { price });
    return rate ?? '';
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => void find()}
          disabled={!validDate || loading}
        >
          {current === null
            ? t('transactionForm.bondAuctions.find')
            : t('transactionForm.bondAuctions.findAgain')}
        </Button>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {validDate
            ? t('transactionForm.bondAuctions.hint', { date: formatDate(date) })
            : t('transactionForm.bondAuctions.needsDate')}
        </p>
      </div>

      {loading && (
        <div className="text-sm" role="status" aria-busy="true">
          <LoadingSpinner
            size="sm"
            fullContainer={false}
            text={t('transactionForm.bondAuctions.loading')}
          />
        </div>
      )}
      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('transactionForm.bondAuctions.loadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void find()}>
            {t('transactionForm.bondSeries.retry')}
          </Button>
        </div>
      )}

      {current !== null && auctions.length === 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300" role="status">
          {t('transactionForm.bondAuctions.none', { date: formatDate(current.date) })}
        </p>
      )}

      {current !== null && auctions.length > 0 && (
        <div className="space-y-2">
          {terms.length > 1 && (
            <div
              className={SEGMENTED_GROUP_CLASS + ' flex-wrap'}
              role="group"
              aria-label={t('transactionForm.bondAuctions.termFilter')}
            >
              <button
                type="button"
                aria-pressed={term === ALL_TERMS}
                className={segmentClass(term === ALL_TERMS)}
                onClick={() => setTerm(ALL_TERMS)}
              >
                {t('transactionForm.bondAuctions.allTerms')}
              </button>
              {terms.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={term === name}
                  className={segmentClass(term === name)}
                  onClick={() => setTerm(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <ul
            className="max-h-72 divide-y divide-gray-200 overflow-y-auto rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700"
            aria-label={t('transactionForm.bondAuctions.listLabel', {
              date: formatDate(current.date),
            })}
          >
            {shown.map((a) => {
              const rate = rateText(a);
              const busy = picking === a.seriesCode;
              return (
                <li key={`${a.identifier}|${a.issueDate}`}>
                  <button
                    type="button"
                    disabled={a.announced || picking !== null}
                    onClick={() => void pick(a)}
                    className={`flex w-full flex-col gap-1 px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-70 sm:flex-row sm:items-center sm:justify-between ${HOVER_ROW_ON_CARD}`}
                  >
                    <span className="flex flex-col">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                        {t('transactionForm.bondAuctions.title', {
                          term: a.term,
                          identifier: a.identifier,
                        })}
                        {a.reopening && (
                          <Badge variant="gray">{t('transactionForm.bondAuctions.reopening')}</Badge>
                        )}
                      </span>
                      <span className="text-gray-600 dark:text-gray-300">
                        {t('transactionForm.bondAuctions.dates', {
                          auction: formatDate(a.auctionDate),
                          issue: formatDate(a.issueDate),
                          maturity: formatDate(a.maturityDate),
                        })}
                      </span>
                    </span>
                    <span className="text-gray-700 sm:text-right dark:text-gray-200">
                      {busy
                        ? t('transactionForm.bondAuctions.fetching')
                        : a.announced
                          ? t('transactionForm.bondAuctions.announced')
                          : resultText(rate, a.pricePer100)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pickError !== null && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {pickError}
        </p>
      )}
    </div>
  );
}
