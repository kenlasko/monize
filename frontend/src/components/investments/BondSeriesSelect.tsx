'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { baseInvestmentAction } from '@/lib/investment-actions';
import { programSeries, saleWindowMonth, sortBySaleWindowDesc } from '@/lib/bond-series';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import type { InvestmentAction, Security } from '@/types/investment';
import type {
  BondExpectedSeries,
  BondInstrumentSummary,
  BondLotsRefusalCode,
  BondProgramSummary,
  BondSeriesHolding,
  BondSeriesOnSale,
} from '@/types/bond';

/**
 * What a share-moving row says about its series. An acquisition (BUY, REINVEST)
 * may leave the series to the server, which infers it from the date; a transfer
 * in or an added holding must name it; a removal names the series it leaves, or
 * takes the oldest lots first.
 */
export type BondSeriesKind = 'acquire' | 'select' | 'remove';

/**
 * Whether an action moves shares of a program-linked security, and which way
 * (spec `bond-program-securities.md` 2.3). A combined TRANSFER and the TRANSFER_OUT
 * leg of a posted transfer move lots with their series, so they name none.
 */
export function bondSeriesKind(action: InvestmentAction): BondSeriesKind | null {
  switch (baseInvestmentAction(action)) {
    case 'BUY':
    case 'REINVEST':
      return 'acquire';
    case 'ADD_SHARES':
    case 'TRANSFER_IN':
      return 'select';
    case 'SELL':
    case 'REMOVE_SHARES':
      return 'remove';
    default:
      return null;
  }
}

/** The select's value for "fetch the expected series", never a series id. */
const FETCH_VALUE = '__fetch__';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The errors the server raises about the series of a share-moving row. */
export const BOND_SERIES_ERROR_CODES = [
  'SERIES_NOT_IN_PROGRAM',
  'SERIES_NOT_DETERMINED',
  'SERIES_REQUIRED',
  'REMOVAL_EXCEEDS_SERIES',
  'OVER_REMOVAL',
] as const;

const LOTS_REFUSAL_CODES: readonly string[] = [
  'SPLIT',
  'FRACTIONAL_QUANTITY',
  'OVER_REMOVAL',
  'INVALID_QUANTITY',
  'REMOVAL_EXCEEDS_SERIES',
  'SERIES_NOT_DETERMINED',
] satisfies BondLotsRefusalCode[];

interface CatalogData {
  key: string;
  program: BondProgramSummary | null;
  instruments: BondInstrumentSummary[];
}

interface OnSaleData {
  key: string;
  onSale: BondSeriesOnSale | null;
}

interface ExpectedData {
  key: string;
  expected: BondExpectedSeries;
}

interface RemovalData {
  key: string;
  holdings: BondSeriesHolding[];
  /** The lots refusal code when the endpoint answered 422; the holdings are then empty. */
  refusal: BondLotsRefusalCode | null;
  /** The code of the row's stored series, when it could be told. */
  storedCode: string | null;
}

export interface BondSeriesLookup {
  /** The form's date, YYYY-MM-DD; a lookup waits for a calendar date. */
  date: string;
  /** The account the removal leaves; a removal lists nothing without one. */
  accountId?: string;
  /** The row being edited: its own lots are not counted as held. */
  excludeTransactionId?: string;
  /** The series the edited row stores, passed only while its kind is the stored one. */
  storedInstrumentId?: string | null;
}

export interface BondSeriesOptions {
  kind: BondSeriesKind;
  options: Array<{ value: string; label: string }>;
  isLoading: boolean;
  /** The lists could not be read; that is not "no series". */
  loadFailed: boolean;
  /** A removal's lots cannot be derived: the reason, translated; only "Oldest first" is offered. */
  refusal: string | null;
  retry: () => void;
  /** The series to offer to fetch: the date's code, when no stored series is on sale. */
  fetchCode: string | null;
  /** The issuing country the fetch is addressed to, as the server names it. */
  fetchCountryCode: string | null;
  /** Adds a just-fetched series to the list and re-reads the catalog. */
  addInstrument: (instrument: BondInstrumentSummary) => void;
  /** The security's program, once the catalog is read. */
  program: BondProgramSummary | null;
  /**
   * The program sells by auction (no sale window holds a date), so a purchase
   * names its auction: `BondAuctionFinder` lists them.
   */
  listsAuctions: boolean;
}

/**
 * The series a share-moving row of a program-linked security can name.
 *
 * An acquisition asks the server which series the date infers (and labels the
 * default option with it); a transfer in lists every stored series of the
 * program; a removal lists the series the account holds on the date, with their
 * quantities. Each answer is kept with the key that produced it so a lookup for
 * another security, account or date is never shown as this one's, and a failed
 * read is a failure, never an empty list. Returns null when the security is not
 * program-linked or the action names no series.
 */
export function useBondSeriesOptions(
  security: Security | null | undefined,
  kind: BondSeriesKind | null,
  lookup: BondSeriesLookup,
): BondSeriesOptions | null {
  const t = useTranslations('investments');
  const tSec = useTranslations('securities');
  const tDetail = useTranslations('securityDetail');
  const { formatShareQuantity } = useNumberFormat();
  const { formatDate, formatMonth } = useDateFormat();
  const programId = security?.bondProgramId ?? null;
  const securityId = security?.id ?? null;
  const active = programId !== null && securityId !== null && kind !== null;
  const { date, accountId, excludeTransactionId, storedInstrumentId } = lookup;
  const validDate = DATE_RE.test(date);

  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [onSaleData, setOnSaleData] = useState<OnSaleData | null>(null);
  const [expectedData, setExpectedData] = useState<ExpectedData | null>(null);
  const [removal, setRemoval] = useState<RemovalData | null>(null);
  const [catalogFailedKey, setCatalogFailedKey] = useState<string | null>(null);
  const [removalFailedKey, setRemovalFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const needsCatalog = kind === 'acquire' || kind === 'select';
  // One catalog read per (security, program): the date only picks from it.
  const catalogKey = `${securityId}|${programId}`;
  // One request per (security, date); a fetched series re-asks.
  const onSaleKey = `${securityId}|${date}|${attempt}`;
  // One request per (security, date); the server names the code, never this client.
  const expectedKey = `${securityId}|${date}`;
  const removalKey = `${securityId}|${accountId ?? ''}|${date}|${excludeTransactionId ?? ''}|${storedInstrumentId ?? ''}`;
  const catalogActive = active && needsCatalog;
  const cat = catalog?.key === catalogKey ? catalog : null;
  const listsAuctions = cat?.program?.listsAuctions === true;
  // An auction program has no sale window: the date infers nothing, so neither
  // lookup is asked (and the catalog decides that before either is).
  const onSaleActive = active && kind === 'acquire' && validDate && cat !== null && !listsAuctions;
  const expectedActive = onSaleActive;
  const removalActive = active && kind === 'remove' && validDate && !!accountId;

  useEffect(() => {
    if (!catalogActive) return;
    let cancelled = false;
    Promise.all([investmentsApi.listBondPrograms(), investmentsApi.listBondInstruments()])
      .then(([programs, instruments]) => {
        if (cancelled) return;
        const program = programs.find((p) => p.id === programId) ?? null;
        setCatalog({
          key: catalogKey,
          program,
          instruments:
            program === null
              ? []
              : programSeries(
                  instruments,
                  program.programCode,
                  program.currency,
                  program.issuerCountryCode,
                ),
        });
        setCatalogFailedKey(null);
      })
      .catch(() => {
        if (!cancelled) setCatalogFailedKey(catalogKey);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogActive, catalogKey, programId, attempt]);

  useEffect(() => {
    if (!onSaleActive) return;
    let cancelled = false;
    investmentsApi
      .getBondSeriesOnSale(securityId as string, date)
      .then((onSale) => {
        if (cancelled) return;
        setOnSaleData({ key: onSaleKey, onSale });
      })
      .catch(() => {
        // The default option then keeps its generic label ("Determined from the
        // date"): the server still infers the series on submit and says if it cannot.
      });
    return () => {
      cancelled = true;
    };
  }, [onSaleActive, onSaleKey, securityId, date]);

  useEffect(() => {
    if (!expectedActive) return;
    let cancelled = false;
    investmentsApi
      .getExpectedBondSeries(securityId as string, date)
      .then((expected) => {
        if (cancelled) return;
        setExpectedData({ key: expectedKey, expected });
      })
      .catch(() => {
        // No answer, no fetch action: a wrong code is never proposed. The
        // answer kept belongs to another key and is not shown.
      });
    return () => {
      cancelled = true;
    };
  }, [expectedActive, expectedKey, securityId, date]);

  useEffect(() => {
    if (!removalActive) return;
    let cancelled = false;
    const storedCodeOf = async (): Promise<string | null> => {
      if (!storedInstrumentId) return null;
      try {
        const all = await investmentsApi.listBondInstruments();
        return all.find((i) => i.id === storedInstrumentId)?.seriesCode ?? null;
      } catch {
        return null;
      }
    };
    investmentsApi
      .getBondSeriesHoldings(securityId as string, accountId as string, date, excludeTransactionId)
      .then(async (result) => {
        const held = result.holdings;
        const stored =
          storedInstrumentId && !held.some((h) => h.instrumentId === storedInstrumentId)
            ? await storedCodeOf()
            : null;
        if (cancelled) return;
        setRemoval({ key: removalKey, holdings: held, refusal: null, storedCode: stored });
        setRemovalFailedKey(null);
      })
      .catch(async (err: unknown) => {
        const code = getErrorCode(err);
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 422 && code !== undefined && LOTS_REFUSAL_CODES.includes(code)) {
          const stored = await storedCodeOf();
          if (cancelled) return;
          setRemoval({
            key: removalKey,
            holdings: [],
            refusal: code as BondLotsRefusalCode,
            storedCode: stored,
          });
          setRemovalFailedKey(null);
          return;
        }
        if (!cancelled) setRemovalFailedKey(removalKey);
      });
    return () => {
      cancelled = true;
    };
  }, [removalActive, removalKey, securityId, accountId, date, excludeTransactionId, storedInstrumentId, attempt]);

  const onSale = onSaleData?.key === onSaleKey ? onSaleData : null;
  const rem = removal?.key === removalKey ? removal : null;
  // Only to propose which code to fetch; the value sent is never derived from it.
  const expectedAnswer = expectedData?.key === expectedKey ? expectedData.expected : null;
  const expected =
    kind === 'acquire' && expectedAnswer !== null && expectedAnswer.fetchable
      ? expectedAnswer.seriesCode
      : null;
  const expectedStored =
    expected === null ? undefined : cat?.instruments.find((i) => i.seriesCode === expected);
  const noneOnSale = onSale !== null && onSale.onSale === null;
  const fetchCode =
    noneOnSale && cat !== null && expected !== null && expectedStored === undefined
      ? expected
      : null;

  const options = useMemo(() => {
    if (kind === 'remove') {
      const list = [{ value: '', label: t('transactionForm.bondSeries.oldestFirst') }];
      for (const h of rem?.holdings ?? []) {
        list.push({
          value: h.instrumentId,
          label: t('transactionForm.bondSeries.heldOption', {
            code: h.seriesCode,
            quantity: formatShareQuantity(h.quantity),
          }),
        });
      }
      if (rem !== null && storedInstrumentId && !list.some((o) => o.value === storedInstrumentId)) {
        // The stored value stays visible, and is never mislabelled as held.
        list.push({
          value: storedInstrumentId,
          label:
            rem.refusal !== null
              ? (rem.storedCode ?? t('transactionForm.bondSeries.storedSeries'))
              : rem.storedCode !== null
                ? t('transactionForm.bondSeries.noLongerHeld', { code: rem.storedCode })
                : t('transactionForm.bondSeries.noLongerHeldUnknown'),
        });
      }
      return list;
    }
    // The code and the period it was on sale, so a series is told by either.
    const seriesLabel = (code: string, window: { from: string; to: string } | null | undefined) => {
      if (window === null || window === undefined) return code;
      const month = saleWindowMonth(window);
      return month !== null
        ? t('transactionForm.bondSeries.seriesOnSaleMonth', { code, month: formatMonth(month) })
        : t('transactionForm.bondSeries.seriesOnSaleRange', {
            code,
            from: formatDate(window.from),
            to: formatDate(window.to),
          });
    };
    const windowOf = (code: string) =>
      cat?.instruments.find((i) => i.seriesCode === code)?.saleWindow ?? null;
    const stored = sortBySaleWindowDesc(cat?.instruments ?? []).map((i) => ({
      value: i.id,
      label: seriesLabel(i.seriesCode, i.saleWindow),
    }));
    if (kind === 'select') {
      return [{ value: '', label: t('transactionForm.bondSeries.choose') }, ...stored];
    }
    const defaultLabel = listsAuctions
      ? t('transactionForm.bondSeries.chooseAuction')
      : onSale === null
        ? t('transactionForm.bondSeries.fromDate')
        : onSale.onSale === null
          ? t('transactionForm.bondSeries.noneOnSale')
          : t('transactionForm.bondSeries.fromDateCode', {
              code: seriesLabel(onSale.onSale.seriesCode, windowOf(onSale.onSale.seriesCode)),
            });
    const list = [{ value: '', label: defaultLabel }, ...stored];
    if (fetchCode !== null) {
      list.push({
        value: FETCH_VALUE,
        // Never stored when offered, so its window is not known here.
        label: tSec('form.bondFetchAction', { code: fetchCode }),
      });
    }
    return list;
  }, [kind, rem, cat, onSale, fetchCode, storedInstrumentId, listsAuctions, formatShareQuantity, formatDate, formatMonth, t, tSec]);

  if (!active) return null;
  const catalogLoading = needsCatalog && cat === null && catalogFailedKey !== catalogKey;
  const catalogFailed = needsCatalog && cat === null && catalogFailedKey === catalogKey;
  const removalLoading =
    kind === 'remove' && removalActive && rem === null && removalFailedKey !== removalKey;
  const removalFailed =
    kind === 'remove' && removalActive && rem === null && removalFailedKey === removalKey;
  return {
    kind,
    options,
    isLoading: catalogLoading || removalLoading,
    loadFailed: catalogFailed || removalFailed,
    refusal: rem?.refusal != null ? tDetail(`bond.lotsRefusal.${rem.refusal}`) : null,
    retry: () => {
      setCatalogFailedKey(null);
      setRemovalFailedKey(null);
      setAttempt((n) => n + 1);
    },
    fetchCode,
    fetchCountryCode: expected === null ? null : (expectedAnswer?.countryCode ?? null),
    program: cat?.program ?? null,
    listsAuctions,
    addInstrument: (instrument) => {
      // Shown at once, then the catalog and the date's series are re-read so
      // they are the server's.
      setCatalog((current) =>
        current === null || current.instruments.some((i) => i.id === instrument.id)
          ? current
          : {
              ...current,
              instruments: [...current.instruments, instrument].sort((a, b) =>
                a.seriesCode.localeCompare(b.seriesCode),
              ),
            },
      );
      setAttempt((n) => n + 1);
    },
  };
}

interface BondSeriesSelectProps {
  series: BondSeriesOptions;
  /** The series shown and sent: the reader's pick; '' is the default (the server's choice). */
  value: string;
  onChange: (bondInstrumentId: string) => void;
  /** The server's refusal about the series, said where the reader picks it. */
  error?: string;
}

/**
 * The series select of the investment transaction form. For an acquisition the
 * last option fetches the series the date expects from the official source when
 * the catalog does not hold it; the series fetched is then selected.
 */
export function BondSeriesSelect({ series, value, onChange, error }: BondSeriesSelectProps) {
  const t = useTranslations('investments');
  const tSec = useTranslations('securities');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Set synchronously, so two changes in one tick cannot both send.
  const inFlight = useRef(false);

  const handleFetch = async () => {
    const code = series.fetchCode;
    if (inFlight.current || code === null || series.fetchCountryCode === null) return;
    inFlight.current = true;
    setFetching(true);
    setFetchError(null);
    try {
      const result = await investmentsApi.fetchBondSeries(series.fetchCountryCode, code);
      series.addInstrument(result);
      onChange(result.id);
    } catch (err) {
      setFetchError(getErrorMessage(err, tSec('form.bondFetchFailed')));
    } finally {
      inFlight.current = false;
      setFetching(false);
    }
  };

  return (
    <div>
      <Select
        label={t('transactionForm.bondSeries.label')}
        options={series.options}
        value={value}
        disabled={fetching}
        onChange={(e) => {
          if (e.target.value === FETCH_VALUE) {
            void handleFetch();
            return;
          }
          setFetchError(null);
          onChange(e.target.value);
        }}
        error={error}
      />
      {fetching && series.fetchCode !== null && (
        <div className="mt-1 text-sm" role="status" aria-busy="true">
          <LoadingSpinner
            size="sm"
            fullContainer={false}
            text={tSec('form.bondFetching', { code: series.fetchCode })}
          />
        </div>
      )}
      {fetchError !== null && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {fetchError}
        </p>
      )}
      {series.refusal !== null && (
        <p role="alert" className="mt-1 text-sm text-amber-700 dark:text-amber-300">
          {series.refusal}
        </p>
      )}
      {series.isLoading && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('transactionForm.bondSeries.loading')}
        </p>
      )}
      {series.loadFailed && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('transactionForm.bondSeries.loadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={series.retry}>
            {t('transactionForm.bondSeries.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
