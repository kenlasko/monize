'use client';

import { useMemo, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import {
  AssetAllocation,
  AllocationItem,
  AccountHoldings,
  CountryWeightingResult,
  AssetClassWeightingResult,
  PortfolioTagSummary,
} from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import {
  collapseLookThrough,
  type LookThroughResult,
} from '@/lib/look-through-allocation';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useAssetClassLabel, type AssetClassName } from '@/hooks/useAssetClassLabel';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

type GroupBy = 'security' | 'tag' | 'tagKey' | 'country' | 'assetClass';

/** An empty look-through result, used when a fetch fails. */
const EMPTY_LOOK_THROUGH = {
  items: [],
  totalPortfolioValue: 0,
  totalDirectValue: 0,
  totalEtfValue: 0,
  unclassifiedValue: 0,
};

/**
 * A look-through result as pie slices. `collapseLookThrough` decides which
 * buckets stay individual and what merges into Other; colours come from the
 * themed categorical palette, since the backend assigns none.
 */
function buildLookThroughAllocation(
  result: LookThroughResult,
  otherLabel: string,
  sliceType: AllocationItem['type'],
): AssetAllocation {
  const allocation: AllocationItem[] = collapseLookThrough(
    result,
    otherLabel,
  ).map((slice, index) => ({
    name: slice.name,
    symbol: null,
    type: slice.isOther ? 'other' : sliceType,
    value: slice.value,
    percentage: slice.percentage,
    color: slice.isOther ? chartColors.axis : CHART_SERIES[index % CHART_SERIES.length],
  }));

  return { allocation, totalValue: result.totalPortfolioValue ?? result.knownSubtotal ?? 0 };
}

/** Country look-through -> pie slices. */
function buildCountryAllocation(
  result: CountryWeightingResult,
  otherCountriesLabel: string,
): AssetAllocation {
  return buildLookThroughAllocation(
    {
      ...result,
      items: result.items.map((i) => ({ ...i, name: i.country })),
    },
    otherCountriesLabel,
    'country',
  );
}

/** Asset-class look-through -> pie slices, each class named by `labelOf`. */
function buildAssetClassAllocation(
  result: AssetClassWeightingResult,
  otherClassesLabel: string,
  labelOf: (item: AssetClassName) => string,
): AssetAllocation {
  return buildLookThroughAllocation(
    {
      ...result,
      items: result.items.map((i) => ({ ...i, name: labelOf(i) })),
    },
    otherClassesLabel,
    'assetClass',
  );
}

function AllocationTooltip({
  active,
  payload,
  fmtVal,
  foreignCurrency,
  foreignTotal,
}: {
  active?: boolean;
  payload?: Array<{
    payload: { fullName: string; value: number; percentage: number; currencyCode?: string };
  }>;
  fmtVal: (v: number) => string;
  foreignCurrency: string | null;
  foreignTotal: number;
}) {
  const { formatPercent } = useNumberFormat();
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const displayValue = foreignCurrency
      ? (data.percentage / 100) * foreignTotal
      : data.value;
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {data.fullName}
        </p>
        <p className="text-gray-600 dark:text-gray-400">
          {fmtVal(displayValue)} ({formatPercent(data.percentage, 1)})
        </p>
      </div>
    );
  }
  return null;
}

interface AssetAllocationChartProps {
  allocation: AssetAllocation | null;
  isLoading: boolean;
  singleAccountCurrency?: string | null;
  holdingsByAccount?: AccountHoldings[];
  titleSuffix?: string;
  /**
   * Account IDs the parent is currently filtering by. Used to fetch the
   * by-tag and by-country allocations for the currently selected accounts.
   */
  accountIds?: string[];
  /**
   * Whether the "By tag" grouping is eligible at all. Even when enabled, the
   * toggle only appears once we confirm the selected accounts actually have
   * tagged holdings.
   */
  enableTagGrouping?: boolean;
  /**
   * False when the portfolio valuation is incomplete (a missing price or FX
   * rate). The percentages here are then shares of the known subtotal, not of the
   * whole portfolio, so the chart says so rather than presenting them as
   * definitive (recheck RR5-005). Absent reads as complete.
   */
  valuationComplete?: boolean;
}

export function AssetAllocationChart({
  allocation,
  isLoading,
  singleAccountCurrency,
  holdingsByAccount,
  titleSuffix,
  accountIds,
  enableTagGrouping = true,
  valuationComplete,
}: AssetAllocationChartProps) {
  const t = useTranslations('investments');
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();

  const [groupBy, setGroupBy] = useState<GroupBy>('security');
  // By-tag, by-country and by-asset-class data cached per account-filter key so
  // toggling back and forth (or re-selecting the same accounts) does not
  // refetch. The country and asset-class look-throughs are fetched eagerly so
  // we know which selectors to offer before the user acts. The by-tag
  // allocation is NOT: it costs a whole portfolio valuation on the server, and
  // it was paid for on every page open whether or not anyone looked at the tag
  // view. Whether to offer the tag toggle at all is answered by the cheap tag
  // summary below instead, and the allocation is fetched the first time the tag
  // view is actually selected.
  const [tagCache, setTagCache] = useState<Record<string, AssetAllocation>>({});
  const [countryCache, setCountryCache] = useState<
    Record<string, CountryWeightingResult>
  >({});
  const [assetClassCache, setAssetClassCache] = useState<
    Record<string, AssetClassWeightingResult>
  >({});
  // KEY:VALUE aggregation: the available keys per account-filter, the key the
  // user picked, and the by-key allocation cached per `accountKey|key`.
  const [tagSummaryCache, setTagSummaryCache] = useState<
    Record<string, PortfolioTagSummary>
  >({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tagKeyCache, setTagKeyCache] = useState<Record<string, AssetAllocation>>(
    {},
  );
  const accountKey =
    accountIds && accountIds.length > 0 ? [...accountIds].sort().join(',') : 'all';

  // Fetch once per account-filter change (not per cache update): the API client
  // already de-dupes rapid repeat selections via its 60s cache, and the results
  // land in state keyed by accountKey so switching back is instant. `cancelled`
  // guards against a late response overwriting a newer selection.
  useEffect(() => {
    let cancelled = false;
    const ids = accountKey === 'all' ? undefined : accountKey.split(',');

    if (enableTagGrouping) {
      investmentsApi
        .getPortfolioTagSummary(ids)
        .then((summary) => {
          if (!cancelled)
            setTagSummaryCache((prev) => ({ ...prev, [accountKey]: summary }));
        })
        .catch(() => {
          if (!cancelled)
            setTagSummaryCache((prev) => ({
              ...prev,
              [accountKey]: { keys: [], hasTaggedHoldings: false },
            }));
        });
    }

    investmentsApi
      .getCountryWeightings(ids)
      .then((res) => {
        if (!cancelled)
          setCountryCache((prev) => ({ ...prev, [accountKey]: res }));
      })
      .catch(() => {
        if (!cancelled)
          setCountryCache((prev) => ({
            ...prev,
            [accountKey]: EMPTY_LOOK_THROUGH,
          }));
      });

    investmentsApi
      .getAssetClassWeightings(ids)
      .then((res) => {
        if (!cancelled)
          setAssetClassCache((prev) => ({ ...prev, [accountKey]: res }));
      })
      .catch(() => {
        if (!cancelled)
          setAssetClassCache((prev) => ({
            ...prev,
            [accountKey]: EMPTY_LOOK_THROUGH,
          }));
      });

    return () => {
      cancelled = true;
    };
  }, [accountKey, enableTagGrouping]);

  const otherCountriesLabel = t('assetAllocation.otherCountries');
  const countryResult = countryCache[accountKey];
  const countryAllocation = useMemo(
    () =>
      countryResult
        ? buildCountryAllocation(countryResult, otherCountriesLabel)
        : null,
    [countryResult, otherCountriesLabel],
  );

  const otherClassesLabel = t('assetAllocation.otherAssetClasses');
  const assetClassLabel = useAssetClassLabel();
  const assetClassResult = assetClassCache[accountKey];
  const assetClassAllocation = useMemo(
    () =>
      assetClassResult
        ? buildAssetClassAllocation(assetClassResult, otherClassesLabel, assetClassLabel)
        : null,
    [assetClassResult, otherClassesLabel, assetClassLabel],
  );

  // A selector is only offered once its data confirms it is meaningful for the
  // currently selected accounts: tags in use, or classified country exposure.
  // For tags that confirmation comes from the tag summary, which says whether a
  // held security carries a tag, rather than from an allocation nobody has
  // asked for yet.
  const tagSummary = tagSummaryCache[accountKey];
  const tagsAvailable =
    enableTagGrouping && (tagSummary?.hasTaggedHoldings ?? false);
  const countryAvailable = (countryResult?.items.length ?? 0) > 0;
  const assetClassAvailable = (assetClassResult?.items.length ?? 0) > 0;

  // KEY:VALUE aggregation: keys present for this account filter and the key the
  // chart is currently aggregating by (the user's pick, or the first key).
  const availableKeys = enableTagGrouping ? (tagSummary?.keys ?? []) : [];
  const keysAvailable = availableKeys.length > 0;
  const resolvedKey =
    selectedKey && availableKeys.includes(selectedKey)
      ? selectedKey
      : (availableKeys[0] ?? null);
  const tagKeyCacheKey = resolvedKey ? `${accountKey}|${resolvedKey}` : null;

  // Fetch the by-tag allocation lazily, the first time the tag view is
  // selected. It is a whole portfolio valuation on the server, so a reader who
  // never opens the tag view never pays for one.
  useEffect(() => {
    if (!enableTagGrouping || groupBy !== 'tag') return;
    if (tagCache[accountKey]) return;
    let cancelled = false;
    const ids = accountKey === 'all' ? undefined : accountKey.split(',');
    investmentsApi
      .getAllocationByTag(ids)
      .then((res) => {
        if (!cancelled) setTagCache((prev) => ({ ...prev, [accountKey]: res }));
      })
      .catch(() => {
        if (!cancelled)
          setTagCache((prev) => ({
            ...prev,
            [accountKey]: { allocation: [], totalValue: 0 },
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [enableTagGrouping, groupBy, accountKey, tagCache]);

  // Fetch the by-key allocation lazily, only while the key view is active.
  useEffect(() => {
    if (groupBy !== 'tagKey' || !resolvedKey || !tagKeyCacheKey) return;
    if (tagKeyCache[tagKeyCacheKey]) return;
    let cancelled = false;
    const ids = accountKey === 'all' ? undefined : accountKey.split(',');
    investmentsApi
      .getAllocationByTagKey(resolvedKey, ids)
      .then((res) => {
        if (!cancelled)
          setTagKeyCache((prev) => ({ ...prev, [tagKeyCacheKey]: res }));
      })
      .catch(() => {
        if (!cancelled)
          setTagKeyCache((prev) => ({
            ...prev,
            [tagKeyCacheKey]: { allocation: [], totalValue: 0 },
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [groupBy, resolvedKey, tagKeyCacheKey, accountKey, tagKeyCache]);

  // If the active grouping is no longer available (e.g. the account filter
  // changed to a set without tags or country data), fall back to "By security"
  // for rendering while keeping the user's stored choice for when it returns.
  const effectiveGroupBy: GroupBy =
    groupBy === 'tag' && !tagsAvailable
      ? 'security'
      : groupBy === 'tagKey' && (!keysAvailable || !resolvedKey)
        ? 'security'
        : groupBy === 'country' && !countryAvailable
          ? 'security'
          : groupBy === 'assetClass' && !assetClassAvailable
            ? 'security'
            : groupBy;

  const isTagView = effectiveGroupBy === 'tag';
  const isTagKeyView = effectiveGroupBy === 'tagKey';
  const isCountryView = effectiveGroupBy === 'country';
  const isAssetClassView = effectiveGroupBy === 'assetClass';
  const activeAllocation = isTagView
    ? (tagCache[accountKey] ?? null)
    : isTagKeyView
      ? (tagKeyCacheKey ? (tagKeyCache[tagKeyCacheKey] ?? null) : null)
      : isCountryView
        ? countryAllocation
        : isAssetClassView
          ? assetClassAllocation
          : allocation;
  const activeLoading = isTagView
    ? !tagCache[accountKey]
    : isTagKeyView
      ? !tagKeyCacheKey || !tagKeyCache[tagKeyCacheKey]
      : isCountryView
        ? !countryResult
        : isAssetClassView
          ? !assetClassResult
          : isLoading;

  // When viewing a single foreign-currency account, show values in that
  // currency. The by-tag and by-country allocations are always returned in the
  // default currency, so the foreign-currency display only applies to the
  // security view.
  const foreignCurrency =
    effectiveGroupBy === 'security' &&
    singleAccountCurrency &&
    singleAccountCurrency !== defaultCurrency
      ? singleAccountCurrency
      : null;

  // Compute raw total in the foreign currency from holdingsByAccount
  const foreignTotal = useMemo(() => {
    if (!foreignCurrency || !holdingsByAccount) return 0;
    let total = 0;
    for (const acct of holdingsByAccount) {
      total += acct.cashBalance + acct.totalMarketValue;
    }
    return total;
  }, [foreignCurrency, holdingsByAccount]);

  const fmtVal = (value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  };

  const chartData = useMemo(() => {
    if (!activeAllocation) return [];
    return activeAllocation.allocation.map((item) => {
      const label =
        item.type === 'cash'
          ? t('assetAllocation.cash')
          : item.type === 'untagged'
            ? t('assetAllocation.untagged')
            : item.name;
      return {
        name: item.symbol || label,
        fullName: label,
        value: item.value,
        percentage: item.percentage,
        color: item.color || chartColors.neutral,
        currencyCode: item.currencyCode,
      };
    });
  }, [activeAllocation, t]);

  // Security/tag legends cap at the top 10 slices; the look-through views are
  // already bounded to 10 buckets plus their "Other" slice, so show all.
  const legendData =
    isCountryView || isAssetClassView ? chartData : chartData.slice(0, 10);

  const showToggle =
    tagsAvailable || keysAvailable || countryAvailable || assetClassAvailable;
  const toggleButtonClass = (selected: boolean) =>
    `px-2 py-1 ${
      selected
        ? 'bg-blue-600 text-white'
        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300'
    }`;

  const groupToggle = showToggle ? (
    <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setGroupBy('security')}
        className={toggleButtonClass(effectiveGroupBy === 'security')}
        aria-pressed={effectiveGroupBy === 'security'}
      >
        {t('assetAllocation.groupBy.security')}
      </button>
      {tagsAvailable && (
        <button
          type="button"
          onClick={() => setGroupBy('tag')}
          className={toggleButtonClass(isTagView)}
          aria-pressed={isTagView}
        >
          {t('assetAllocation.groupBy.tag')}
        </button>
      )}
      {keysAvailable && (
        <button
          type="button"
          onClick={() => setGroupBy('tagKey')}
          className={toggleButtonClass(isTagKeyView)}
          aria-pressed={isTagKeyView}
        >
          {t('assetAllocation.groupBy.tagKey')}
        </button>
      )}
      {countryAvailable && (
        <button
          type="button"
          onClick={() => setGroupBy('country')}
          className={toggleButtonClass(isCountryView)}
          aria-pressed={isCountryView}
        >
          {t('assetAllocation.groupBy.country')}
        </button>
      )}
      {assetClassAvailable && (
        <button
          type="button"
          onClick={() => setGroupBy('assetClass')}
          className={toggleButtonClass(isAssetClassView)}
          aria-pressed={isAssetClassView}
        >
          {t('assetAllocation.groupBy.assetClass')}
        </button>
      )}
    </div>
  ) : null;

  const keySelector =
    isTagKeyView && availableKeys.length > 0 ? (
      <select
        value={resolvedKey ?? ''}
        onChange={(e) => setSelectedKey(e.target.value)}
        aria-label={t('assetAllocation.keySelectorLabel')}
        className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1"
      >
        {availableKeys.map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>
    ) : null;

  const heading = (
    <div className="flex items-center justify-between gap-2 mb-4">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('assetAllocation.title')}
        {titleSuffix ? ` (${titleSuffix})` : ''}
      </h3>
      <div className="flex items-center gap-2">
        {keySelector}
        {groupToggle}
      </div>
    </div>
  );

  if (activeLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
        {heading}
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse skeleton-shimmer w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (!activeAllocation || activeAllocation.allocation.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
        {heading}
        <p className="text-gray-500 dark:text-gray-400">
          {isTagView
            ? t('assetAllocation.noTagData')
            : isTagKeyView
              ? t('assetAllocation.noKeyData')
              : isCountryView
                ? t('assetAllocation.noCountryData')
                : t('assetAllocation.noData')}
        </p>
      </div>
    );
  }

  // The warning gates on the view actually RENDERED (`effectiveGroupBy`), not
  // the user's stored choice: the no-tags fallback can draw the security view
  // while `groupBy` still says 'tag', and keying off the stored value dropped
  // the warning over exactly the numbers it was written for (review #1133).
  //
  // And completeness is read from the same aggregate that produced the numbers
  // on screen. In the single foreign-account view the tooltip's values come
  // from `foreignTotal` -- an account-currency aggregate over
  // `holdingsByAccount` -- whose conversion path can be incomplete even when
  // the top-level default-currency flag is clean, so that view checks the
  // per-account flags as well (RR5-001 again; review #1133). Absent fields
  // read as complete, the usual rolling-deploy defence.
  const foreignAggregateIncomplete =
    foreignCurrency !== null &&
    (holdingsByAccount ?? []).some((a) => a.valuationComplete === false);
  const knownValueOnly =
    effectiveGroupBy === 'security' &&
    (valuationComplete === false || foreignAggregateIncomplete);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
      {heading}
      {knownValueOnly && (
        <p className="text-xs text-amber-700 dark:text-amber-300 mb-2">
          {t('assetAllocation.knownValueOnly')}
        </p>
      )}
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<AllocationTooltip fmtVal={fmtVal} foreignCurrency={foreignCurrency} foreignTotal={foreignTotal} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* One vertical column on a phone, three from `sm` up -- the desktop
          density this legend carried before the mobile-first redesign, restored;
          a three-column legend on a 320px screen wrapped every name onto its own
          cramped third, which is why the phone stays single-column. */}
      <ChartLegend
        className="mt-4"
        columnsClassName="sm:grid-cols-3"
        items={legendData.map((item, index) => {
          const isForeign = !foreignCurrency && item.currencyCode && item.currencyCode !== defaultCurrency;
          return {
            key: String(index),
            color: item.color,
            name: (
              <>
                {item.name}
                {isForeign && (
                  <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">({item.currencyCode})</span>
                )}
              </>
            ),
            trailing: formatPercent(item.percentage, 1),
          };
        })}
      />
    </div>
  );
}
