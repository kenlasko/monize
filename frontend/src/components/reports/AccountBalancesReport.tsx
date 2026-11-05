'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { accountsApi } from '@/lib/accounts';
import { institutionsApi } from '@/lib/institutions';
import { Account, isLiabilityAccountType, type AccountBalancesAsOfResponse } from '@/types/account';
import { Institution } from '@/types/institution';
import { buildLogicalAccounts, type LogicalAccount } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { useNumberFormat, type NumberFormatters } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { sumConverted, combineTotals } from '@/lib/currency-total';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useReportData } from '@/hooks/useReportData';
import {
  CHART_COLOURS_ASSETS,
  CHART_COLOURS_LIABILITIES,
} from '@/lib/chart-colours';
import { ReportError } from '@/components/reports/ReportError';
import {
  AccountBalancesControls,
  type ViewMode,
} from '@/components/reports/account-balances/AccountBalancesControls';
import { asOfConverter } from '@/components/reports/account-balances/as-of-rates';
import {
  DEFAULT_FILTERS,
  INSTITUTION_NONE,
  groupEntries,
  institutionKeyFor,
  matchesFilters,
  sortEntries,
  type AccountBalanceFilters,
  type GroupBy,
  type SortBy,
  type SortDirection,
} from '@/components/reports/account-balances/grouping';
import { EmptyState } from '@/components/ui/EmptyState';

const ACCOUNT_TYPE_KEYS = [
  'CHEQUING',
  'SAVINGS',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'LOAN',
  'MORTGAGE',
  'INVESTMENT',
  'CASH',
  'CRYPTO',
  'ASSET',
  'OTHER',
] as const;

interface ReportPayload {
  accounts: Account[];
  institutions: Institution[];
  balances: AccountBalancesAsOfResponse;
}

interface AccountBalancesTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number; signedValue?: number } }>;
  chartTotal: number;
  displayCurrency: string;
  formatCurrency: NumberFormatters['formatCurrency'];
  formatPercent: NumberFormatters['formatPercent'];
}

function AccountBalancesTooltip({
  active,
  payload,
  chartTotal,
  displayCurrency,
  formatCurrency,
  formatPercent,
}: AccountBalancesTooltipProps) {
  if (active && payload?.length) {
    const data = payload[0].payload;
    const pct = chartTotal > 0 ? (data.value / chartTotal) * 100 : 0;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {/* The signed amount: a liability slice is money owed, and the
              minus sign is what says so in text. */}
          {formatCurrency(data.signedValue ?? data.value, displayCurrency)} ({formatPercent(pct, 1)})
        </p>
      </div>
    );
  }
  return null;
}

export function AccountBalancesReport() {
  const t = useTranslations('reports');
  const tAccounts = useTranslations('accounts');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { formatCurrency, defaultCurrency: preferredCurrency, formatPercent } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const mainAccountName = useMainAccountName();

  // A balance is measured at an instant, so the date is a first-class input --
  // and today is the instant a report with no date chosen is about.
  const [asOfDate, setAsOfDate] = useState<string>(() =>
    format(new Date(), 'yyyy-MM-dd'),
  );
  const [filters, setFilters] = useState<AccountBalanceFilters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('type');
  const [sortBy, setSortBy] = useState<SortBy>('balance');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const chartRef = useRef<HTMLDivElement>(null);

  const accountTypeLabels = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        ACCOUNT_TYPE_KEYS.map((key) => [
          key,
          t(`accountBalances.accountTypes.${key}` as Parameters<typeof t>[0]),
        ]),
      ),
    [t],
  );

  const {
    data: response,
    dataKey,
    isLoading,
    error,
    reload,
  } = useReportData<ReportPayload>(
    async () => {
      const [accounts, institutions, balances] = await Promise.all([
        // Closed accounts are selectable now, so they have to be in the list
        // before the status filter can decide whether to show them.
        accountsApi.getAll(true),
        institutionsApi.getAll().catch(() => [] as Institution[]),
        accountsApi.getBalancesAsOf(asOfDate),
      ]);
      return { accounts, institutions, balances };
    },
    [asOfDate],
    {
      requestKey: asOfDate,
      // The payload's own date wins: figures for one day rendered under another
      // day's heading are the mistake this pairing exists to stop.
      keyForResult: (value) => value.balances.asOfDate,
    },
  );

  const accounts = useMemo<Account[]>(() => response?.accounts ?? [], [response]);

  // The figures on screen belong to the date the *response* carries. While a new
  // date is in flight the previous day's numbers are still held, so the heading
  // and the export follow `dataKey` rather than the input.
  const measuredDate = dataKey ?? asOfDate;

  /**
   * Conversion into the reporting currency, at the rates that stood on the
   * measured date -- not today's.
   *
   * A point-in-time report converts at that point in time: what an account was
   * worth *then* is the question it asks, and a live rate answers a different
   * one. Taking the rates from the same payload as the figures is also what
   * keeps the two from drifting apart while a new date is in flight.
   */
  const displayCurrency = response?.balances.displayCurrency ?? preferredCurrency;
  const convertToDisplay = useMemo(
    () => asOfConverter(displayCurrency, response?.balances.displayRates ?? {}),
    [displayCurrency, response],
  );

  /** Ledger balance per account id at the measured date. */
  const ledgerBalances = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of response?.balances.accounts ?? []) {
      map.set(row.accountId, Number(row.balance) || 0);
    }
    return map;
  }, [response]);

  /**
   * Market values per holdings account, in the shape `buildLogicalAccounts`
   * already understands. A row whose `marketValue` is null is deliberately
   * absent: the fold reads an absent entry as unknown, which is what it is.
   */
  const portfolio = useMemo(() => {
    const marketValues = new Map<string, number>();
    const unpricedCounts = new Map<string, number>();
    for (const row of response?.balances.accounts ?? []) {
      if (row.marketValue !== null) marketValues.set(row.accountId, row.marketValue);
      unpricedCounts.set(row.accountId, row.unpricedHoldingsCount ?? 0);
    }
    return { marketValues, unpricedCounts };
  }, [response]);

  const logicalAccounts = useMemo(
    () => buildLogicalAccounts(accounts, mainAccountName, portfolio, ledgerBalances),
    [accounts, mainAccountName, portfolio, ledgerBalances],
  );

  /**
   * Accounts the payload says had not come into existence at the measured date
   * -- an asset before the day it was acquired, an account before its first
   * movement. A balance is a fact about something that exists, so these are not
   * rows worth zero: they are not rows.
   */
  const notYetOpened = useMemo(() => {
    const ids = new Set<string>();
    for (const row of response?.balances.accounts ?? []) {
      // `=== false`, never `!`: a backend that predates the field sends nothing,
      // and absent means "no information", not "did not exist".
      if (row.existsAsOf === false) ids.add(row.accountId);
    }
    return ids;
  }, [response]);

  /**
   * An investment pair is one entity with two ledgers, and they can come into
   * existence on different days -- the cash sleeve funded before the first
   * trade settles. So the entity is dropped only when *every* ledger behind it
   * predates its own inception; one live member is enough to have something to
   * report.
   */
  const openedAccounts = useMemo(
    () =>
      logicalAccounts.filter((entry) =>
        entry.memberIds.some((id) => !notYetOpened.has(id)),
      ),
    [logicalAccounts, notYetOpened],
  );

  const visibleAccounts = useMemo(
    () => openedAccounts.filter((entry) => matchesFilters(entry.primary, filters)),
    [openedAccounts, filters],
  );

  const institutionNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const institution of response?.institutions ?? []) {
      map.set(institution.id, institution.name);
    }
    return map;
  }, [response]);

  /**
   * What to call each institution the accounts belong to.
   *
   * The name is looked for in three places, in order, because a structured
   * institution can be reachable without its record being in hand: the
   * institutions request is allowed to fail without taking the report with it,
   * and a jointly shared account's institution belongs to its owner. Falling
   * straight from "no record" to "No institution" merged every such account
   * into the unfiled bucket, so a user with three banks saw one option reading
   * "No institution" -- and "this account has no institution" and "I could not
   * name its institution" are different facts.
   */
  const institutionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const account of accounts) {
      const key = institutionKeyFor(account);
      if (labels.has(key)) continue;
      if (key === INSTITUTION_NONE) {
        labels.set(key, t('accountBalances.noInstitution'));
        continue;
      }
      if (key.startsWith('name:')) {
        labels.set(key, key.slice('name:'.length));
        continue;
      }
      labels.set(
        key,
        institutionNames.get(key) ??
          account.institution ??
          t('accountBalances.unnamedInstitution'),
      );
    }
    return labels;
  }, [accounts, institutionNames, t]);

  const institutionLabel = useCallback(
    (key: string): string =>
      institutionLabels.get(key) ?? t('accountBalances.noInstitution'),
    [institutionLabels, t],
  );

  const institutionOptions = useMemo(
    () =>
      [...institutionLabels.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [institutionLabels],
  );

  const accountTypeOptions = useMemo(() => {
    const present = new Set(accounts.map((a) => a.accountType));
    return ACCOUNT_TYPE_KEYS.filter((key) => present.has(key)).map((key) => ({
      value: key,
      label: accountTypeLabels[key] ?? key,
    }));
  }, [accounts, accountTypeLabels]);

  /** The signed value in the display currency; null when unknown. */
  const signedDisplayValue = useCallback(
    (entry: LogicalAccount): number | null => {
      if (entry.combinedValue === null) return null;
      return convertToDisplay(entry.combinedValue, entry.primary.currencyCode);
    },
    [convertToDisplay],
  );

  /** The figure a row prints, in the display currency; null when unknown. */
  const displayValue = useCallback(
    (entry: LogicalAccount): number | null => {
      const converted = signedDisplayValue(entry);
      if (converted === null) return null;
      return isLiabilityAccountType(entry.primary.accountType)
        ? Math.abs(converted)
        : converted;
    },
    [signedDisplayValue],
  );

  const groups = useMemo(
    () =>
      groupEntries(visibleAccounts, groupBy).map((group) => ({
        ...group,
        entries: sortEntries(group.entries, sortBy, sortDirection, displayValue),
      })),
    [visibleAccounts, groupBy, sortBy, sortDirection, displayValue],
  );

  const groupLabel = useCallback(
    (key: string): string => {
      switch (groupBy) {
        case 'assetLiability':
          return key === 'liabilities'
            ? t('accountBalances.groupLiabilities')
            : t('accountBalances.groupAssets');
        case 'type':
          return accountTypeLabels[key] ?? key;
        case 'institution':
          return institutionLabel(key);
        case 'status':
          return key === 'closed'
            ? t('accountBalances.groupClosed')
            : t('accountBalances.groupOpen');
        case 'favourite':
          return key === 'favourite'
            ? t('accountBalances.groupFavourite')
            : t('accountBalances.groupOther');
        case 'none':
          return t('accountBalances.groupAll');
      }
    },
    [groupBy, accountTypeLabels, institutionLabel, t],
  );

  /**
   * The figures on screen that came from an observation struck on another day.
   *
   * The server falls back to the closest stored price or rate when the chosen
   * date has none, which is what keeps a total from reading "unavailable" for a
   * day nobody ever loaded data for. A real observation from a nearby day is a
   * usable answer and a different answer, so the report says which figures it
   * applies to rather than presenting them as measurements of the date.
   *
   * Scoped to the accounts actually on screen: a currency approximated for an
   * account the filters excluded is not part of any figure the user is looking
   * at, and claiming otherwise would attach a caveat to a clean total.
   */
  const approximation = useMemo(() => {
    const rows = new Map(
      (response?.balances.accounts ?? []).map((row) => [row.accountId, row]),
    );
    const approximatedRates = response?.balances.approximatedDisplayRates ?? {};
    let holdings = 0;
    const rateNotes = new Map<string, string>();
    for (const entry of visibleAccounts) {
      for (const id of entry.memberIds) {
        const row = rows.get(id);
        if (!row) continue;
        // `?? 0` / `?? []`: a backend that predates these fields sends nothing,
        // and absent means "no information", not "approximated".
        holdings += row.approximatedPriceCount ?? 0;
        for (const pair of row.approximatedRatePairs ?? []) {
          if (!rateNotes.has(pair)) rateNotes.set(pair, pair);
        }
      }
      const currency = entry.primary.currencyCode;
      const struckOn = approximatedRates[currency];
      if (struckOn) {
        rateNotes.set(
          currency,
          t('accountBalances.approximatedRateOn', {
            currency,
            date: formatDate(struckOn),
          }),
        );
      }
    }
    const rates = [...rateNotes.values()].sort();
    return { holdings, rates, active: holdings > 0 || rates.length > 0 };
  }, [response, visibleAccounts, t, formatDate]);

  const approximationDetail = useMemo(() => {
    const clauses: string[] = [];
    if (approximation.holdings > 0) {
      clauses.push(
        t('accountBalances.approximatedPrices', { count: approximation.holdings }),
      );
    }
    if (approximation.rates.length > 0) {
      clauses.push(
        t('accountBalances.approximatedRates', {
          pairs: approximation.rates.join(', '),
        }),
      );
    }
    return clauses.join(' ');
  }, [approximation, t]);

  // Assets and liabilities are decided per account, not per group -- grouping by
  // institution puts both in the same box, and the summary cards must still
  // separate them.
  const totals = useMemo(() => {
    const split = (liabilities: boolean) =>
      sumConverted(
        visibleAccounts.filter(
          (entry) => isLiabilityAccountType(entry.primary.accountType) === liabilities,
        ),
        // An unknown value has no currency to blame, so it is excluded by count
        // -- `sumConverted` treats a non-finite component exactly that way.
        (entry) => entry.combinedValue ?? Number.NaN,
        (entry) => entry.primary.currencyCode,
        convertToDisplay,
      );
    const assets = split(false);
    const rawLiabilities = split(true);
    // A liability is stored negative and reported as what is owed.
    const liabilities = { ...rawLiabilities, value: Math.abs(rawLiabilities.value) };
    const netWorth = combineTotals(
      [assets, liabilities],
      ([assetValue, liabilityValue]) => assetValue - liabilityValue,
    );
    return { assets, liabilities, netWorth };
  }, [visibleAccounts, convertToDisplay]);

  const groupTotal = useCallback(
    (entries: LogicalAccount[]) =>
      sumConverted(
        entries,
        (entry) => entry.combinedValue ?? Number.NaN,
        (entry) => entry.primary.currencyCode,
        convertToDisplay,
      ),
    [convertToDisplay],
  );

  /**
   * A pie can only size a slice from a magnitude, so the sign travels beside
   * it: `signedValue` is what the slice *is* (a liability slice is money owed,
   * not money held), and the two sides draw from separate palettes so their
   * accounting role survives the colour cycling (issue #1243).
   */
  const chartData = useMemo(() => {
    const data: Array<{
      name: string;
      value: number;
      signedValue: number;
      color: string;
    }> = [];
    let assetIdx = 0;
    let liabilityIdx = 0;
    const push = (name: string, rawSignedValue: number) => {
      // At the storage precision: a group netting to a floating-point epsilon
      // is a zero, not a sliver of a slice with a $0.00 legend row.
      const signedValue = Math.round(rawSignedValue * 10000) / 10000;
      // A zero-size slice reads as a measured zero, so it is not drawn.
      if (signedValue === 0) return;
      const color =
        signedValue < 0
          ? CHART_COLOURS_LIABILITIES[liabilityIdx++ % CHART_COLOURS_LIABILITIES.length]
          : CHART_COLOURS_ASSETS[assetIdx++ % CHART_COLOURS_ASSETS.length];
      data.push({ name, value: Math.abs(signedValue), signedValue, color });
    };
    if (groupBy === 'none') {
      for (const entry of visibleAccounts) {
        const converted = signedDisplayValue(entry);
        // No value, no slice: a slice sized from an unconvertible amount is in
        // the wrong currency.
        if (converted === null) continue;
        push(entry.displayName, converted);
      }
    } else {
      for (const group of groups) {
        // A group can hold both signs (an institution with a chequing account
        // and a mortgage), so its slice is the signed net -- the same figure
        // the table prints for that group -- never the sum of magnitudes.
        const signedTotal = group.entries.reduce((sum, entry) => {
          const converted = signedDisplayValue(entry);
          return converted === null ? sum : sum + converted;
        }, 0);
        push(groupLabel(group.key), signedTotal);
      }
    }
    return data.sort((a, b) => b.value - a.value);
  }, [groupBy, groups, visibleAccounts, signedDisplayValue, groupLabel]);

  /**
   * The pie's denominator: the sum of slice magnitudes, which is what each
   * percentage is a share of. With liabilities on screen this is gross
   * exposure, not a total of anything -- the footer prints the signed net
   * worth instead, and this figure stays internal.
   */
  const chartTotal = useMemo(
    () => chartData.reduce((sum, d) => sum + d.value, 0),
    [chartData],
  );

  /**
   * Whether anything on the chart is on the debt side of zero. Decided from
   * the signed components rather than the slices, because a mixed group can
   * net positive while still containing a liability -- its slice is then a net
   * figure, and labelling the footer "Total" over a sum of nets would present
   * net worth under a name that hides the netting.
   */
  const chartHasLiabilities = useMemo(
    () =>
      visibleAccounts.some((entry) => {
        const converted = signedDisplayValue(entry);
        return converted !== null && converted < 0;
      }),
    [visibleAccounts, signedDisplayValue],
  );

  const exportRows = useCallback(
    () =>
      groups.flatMap((group) =>
        group.entries.map((entry) => [
          entry.displayName,
          groupLabel(group.key),
          // An unknown total is exported as unknown, not as the part we do know.
          entry.combinedValue === null
            ? tAccounts('row.combinedUnknown')
            : formatCurrency(entry.combinedValue, entry.primary.currencyCode),
        ]),
      ),
    [groups, groupLabel, formatCurrency, tAccounts],
  );

  const exportHeaders = useMemo(
    () => [
      t('accountBalances.colAccount'),
      t('accountBalances.colGroup'),
      t('accountBalances.colBalance'),
    ],
    [t],
  );

  const subtitle = t('accountBalances.asOfSubtitle', { date: formatDate(measuredDate) });

  const approximationNotice = approximation.active
    ? t('accountBalances.approximatedNotice', { date: formatDate(measuredDate) })
    : '';

  const handleExportCsv = useCallback(async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    exportToCsv(`account-balances-${measuredDate}`, exportHeaders, exportRows());
  }, [exportHeaders, exportRows, measuredDate]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // A missing rate excludes an account from these totals, so the PDF marks
    // them partial too rather than printing a bare figure as the whole.
    const partial = (total: { excludedCount: number }) =>
      total.excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : '';
    await exportToPdf({
      title: t('accountBalances.pdfTitle'),
      // The caveat travels with the export: a printed figure has no tooltip to
      // explain where its prices came from.
      subtitle: approximationNotice
        ? `${subtitle} ${approximationNotice} ${approximationDetail}`.trim()
        : subtitle,
      summaryCards: [
        {
          label: t('accountBalances.totalAssets'),
          value: `${formatCurrency(totals.assets.value, displayCurrency)}${partial(totals.assets)}`,
          color: '#16a34a',
        },
        {
          label: t('accountBalances.totalLiabilities'),
          value: `${formatCurrency(totals.liabilities.value, displayCurrency)}${partial(totals.liabilities)}`,
          color: '#dc2626',
        },
        // Neutral grey when the net worth is a subtotal: its sign is uncertain,
        // so the PDF must not assert a blue/orange the on-screen card just
        // declined to show for the same excluded account.
        {
          label: t('accountBalances.netWorth'),
          value: `${formatCurrency(totals.netWorth.value, displayCurrency)}${partial(totals.netWorth)}`,
          color:
            totals.netWorth.excludedCount > 0
              ? '#111827'
              : totals.netWorth.value >= 0
                ? '#2563eb'
                : '#ea580c',
        },
      ],
      chartContainer: chartRef.current,
      tableData: { headers: exportHeaders, rows: exportRows() },
      filename: `account-balances-${measuredDate}`,
    });
  }, [
    t,
    tCommon,
    subtitle,
    approximationNotice,
    approximationDetail,
    totals,
    formatCurrency,
    displayCurrency,
    exportHeaders,
    exportRows,
    measuredDate,
  ]);

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && !response) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-gray-200 dark:bg-gray-700 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards. A missing rate excludes an account from these totals, so
          each is marked as a subtotal rather than presented as the complete
          figure it no longer is. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6" data-testid="summary-assets">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('accountBalances.totalAssets')}</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            <PartialTotal total={totals.assets} displayCurrency={displayCurrency}>
              {formatCurrency(totals.assets.value, displayCurrency)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6" data-testid="summary-liabilities">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('accountBalances.totalLiabilities')}</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            <PartialTotal total={totals.liabilities} displayCurrency={displayCurrency}>
              {formatCurrency(totals.liabilities.value, displayCurrency)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6" data-testid="summary-networth">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('accountBalances.netWorth')}</div>
          <div className={`text-2xl font-bold ${
            // A partial net worth has an uncertain sign, so it stays neutral
            // rather than asserting a blue/orange the subtotal cannot vouch for.
            totals.netWorth.excludedCount > 0
              ? 'text-gray-900 dark:text-gray-100'
              : totals.netWorth.value >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'
          }`}>
            <PartialTotal total={totals.netWorth} displayCurrency={displayCurrency}>
              {formatCurrency(totals.netWorth.value, displayCurrency)}
            </PartialTotal>
          </div>
        </div>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="as-of-caption">
        {subtitle}
      </p>

      {/* A figure priced from a neighbouring day is an answer, not a
          measurement of this day, and the difference is invisible in the
          number itself. The tooltip names which holdings and which rates, so
          the caveat is something the reader can act on. */}
      {approximation.active && (
        <p
          className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-1"
          data-testid="approximation-notice"
        >
          <span>{approximationNotice}</span>
          <InfoTooltip placement="top" text={approximationDetail} usePortal />
        </p>
      )}

      <AccountBalancesControls
        asOfDate={asOfDate}
        onAsOfDateChange={setAsOfDate}
        filters={filters}
        onFiltersChange={setFilters}
        institutionOptions={institutionOptions}
        accountTypeOptions={accountTypeOptions}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        sortBy={sortBy}
        onSortByChange={setSortBy}
        sortDirection={sortDirection}
        onSortDirectionToggle={() =>
          setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
        }
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onExportPdf={handleExportPdf}
        onExportCsv={handleExportCsv}
      />

      {viewMode === 'chart' && (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          {chartData.length === 0 ? (
            <EmptyState title={t('accountBalances.noData')} />
          ) : (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={
                        <AccountBalancesTooltip
                          chartTotal={chartTotal}
                          displayCurrency={displayCurrency}
                          formatCurrency={formatCurrency}
                          formatPercent={formatPercent}
                        />
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 max-h-48 overflow-y-auto scrollbar-slim">
                {chartData.map((item, index) => {
                  const pct = chartTotal > 0 ? (item.value / chartTotal) * 100 : 0;
                  return (
                    <div
                      key={index}
                      className="flex items-center gap-2 text-sm"
                      data-testid="chart-legend-item"
                    >
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-gray-600 dark:text-gray-400 truncate">{item.name}</span>
                      {/* Signed, so a liability's role is stated in text, not
                          only in the palette. */}
                      <span className="text-gray-900 dark:text-gray-100 ml-auto whitespace-nowrap">
                        {formatCurrency(item.signedValue, displayCurrency)} ({formatPercent(pct, 1)})
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* With liabilities in the mix the sum of slice magnitudes is
                  gross exposure, not a total -- the honest footer figure is
                  the signed net worth, matching the summary card above,
                  partial marker included. */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
                {chartHasLiabilities ? (
                  <>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {t('accountBalances.netWorth')}
                    </div>
                    <div
                      className="font-semibold text-gray-900 dark:text-gray-100"
                      data-testid="chart-net-worth"
                    >
                      <PartialTotal total={totals.netWorth} displayCurrency={displayCurrency}>
                        {formatCurrency(totals.netWorth.value, displayCurrency)}
                      </PartialTotal>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {t('accountBalances.total')}
                    </div>
                    <div
                      className="font-semibold text-gray-900 dark:text-gray-100"
                      data-testid="chart-total"
                    >
                      {formatCurrency(chartTotal, displayCurrency)}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {viewMode === 'table' && (
        <>
          {groups.map((group) => {
            const total = groupTotal(group.entries);
            // Which sign a group's heading should be painted in is only a
            // question a group of one kind can answer, so a mixed group (grouped
            // by institution, say) takes the neutral colour rather than
            // asserting one of them.
            const kinds = new Set(
              group.entries.map((entry) => isLiabilityAccountType(entry.primary.accountType)),
            );
            const isLiabilityGroup = kinds.size === 1 && kinds.has(true);
            return (
              <div key={group.key} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {groupLabel(group.key)}
                  </h3>
                  <span className={`font-semibold ${
                    isLiabilityGroup
                      ? 'text-red-600 dark:text-red-400'
                      : kinds.size > 1
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-green-600 dark:text-green-400'
                  }`}>
                    <PartialTotal total={total} displayCurrency={displayCurrency}>
                      {formatCurrency(
                        isLiabilityGroup ? Math.abs(total.value) : total.value,
                        displayCurrency,
                      )}
                    </PartialTotal>
                  </span>
                </div>
                <div className="divide-y divide-gray-200 dark:divide-gray-700">
                  {group.entries.map((entry) => {
                    const acc = entry.primary;
                    const isLiability = isLiabilityAccountType(acc.accountType);
                    const combined = entry.combinedValue;
                    const marketValue = entry.holdingsAccountId
                      ? portfolio.marketValues.get(entry.holdingsAccountId)
                      : undefined;
                    const cashComponent = entry.cash
                      ? (ledgerBalances.get(entry.cash.id) ?? 0)
                      : (ledgerBalances.get(acc.id) ?? 0);
                    return (
                      <button
                        key={entry.id}
                        onClick={() =>
                          entry.holdingsAccountId
                            ? router.push('/investments')
                            : router.push(`/transactions?accountId=${acc.id}`)
                        }
                        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                      >
                        <div>
                          <div className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                            {entry.displayName}
                            {acc.isClosed && (
                              <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded">
                                {t('accountBalances.closed')}
                              </span>
                            )}
                          </div>
                          {entry.holdingsAccountId && marketValue !== undefined && combined !== null && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {tAccounts('row.combinedBreakdown', {
                                investments: formatCurrency(marketValue, acc.currencyCode),
                                cash: formatCurrency(cashComponent, acc.currencyCode),
                              })}
                            </div>
                          )}
                          {!entry.holdingsAccountId && acc.description && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {acc.description}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {combined === null ? (
                            /* Some component of the total is unknown, so the row
                               says so rather than showing the part it does know. */
                            <>
                              <div className="font-semibold text-gray-500 dark:text-gray-400">
                                {'\u2014'}
                              </div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                {tAccounts('row.combinedUnknown')}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className={`font-semibold ${
                                isLiability ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                              }`}>
                                {formatCurrency(isLiability ? Math.abs(combined) : combined, acc.currencyCode)}
                              </div>
                              {acc.currencyCode !== displayCurrency &&
                                (() => {
                                  // Nothing rather than the unconverted amount under
                                  // the display currency's symbol.
                                  const approx = convertToDisplay(
                                    Math.abs(combined),
                                    acc.currencyCode,
                                  );
                                  if (approx === null) return null;
                                  return (
                                    <div className="text-xs text-gray-400 dark:text-gray-500">
                                      {'\u2248 '}{formatCurrency(approx, displayCurrency)}
                                    </div>
                                  );
                                })()}
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {visibleAccounts.length === 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
              <p className="text-gray-500 dark:text-gray-400">
                {accounts.length === 0
                  ? t('accountBalances.noAccounts')
                  : openedAccounts.length === 0
                    ? /* Every account the user has postdates the chosen day, so
                         the filters are not what emptied the report. */
                      t('accountBalances.noAccountsOnDate', {
                        date: formatDate(measuredDate),
                      })
                    : t('accountBalances.noAccountsForFilters')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
