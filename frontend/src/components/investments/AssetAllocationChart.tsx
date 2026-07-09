'use client';

import { useMemo, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import {
  AssetAllocation,
  AllocationItem,
  AccountHoldings,
  CountryWeightingResult,
} from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

type GroupBy = 'security' | 'tag' | 'tagKey' | 'country';

/**
 * Collapse a country look-through result into pie slices: the ten largest
 * countries kept individually, everything else (countries ranked 11+ plus the
 * backend's unclassified remainder) merged into a single "Other Countries"
 * slice. Colours come from the themed categorical palette since the backend
 * does not assign per-country colours.
 */
function buildCountryAllocation(
  result: CountryWeightingResult,
  otherCountriesLabel: string,
): AssetAllocation {
  const TOP_N = 10;
  const total = result.totalPortfolioValue;
  // Backend already sorts by value descending, but sort defensively.
  const sorted = [...result.items].sort((a, b) => b.totalValue - a.totalValue);
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);

  const pct = (value: number) => (total > 0 ? (value / total) * 100 : 0);

  const allocation: AllocationItem[] = top.map((item, index) => ({
    name: item.country,
    symbol: null,
    type: 'country',
    value: item.totalValue,
    percentage: item.percentage,
    color: CHART_SERIES[index % CHART_SERIES.length],
  }));

  // Integer-cents math to avoid floating-point accumulation drift.
  const otherCents = rest.reduce(
    (sum, item) => sum + Math.round(item.totalValue * 10000),
    Math.round(result.unclassifiedValue * 10000),
  );
  const otherValue = otherCents / 10000;
  if (otherValue > 0.0001) {
    allocation.push({
      name: otherCountriesLabel,
      symbol: null,
      type: 'other',
      value: otherValue,
      percentage: pct(otherValue),
      color: chartColors.axis,
    });
  }

  return { allocation, totalValue: total };
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
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const displayValue = foreignCurrency
      ? (data.percentage / 100) * foreignTotal
      : data.value;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {data.fullName}
        </p>
        <p className="text-gray-600 dark:text-gray-400">
          {fmtVal(displayValue)} ({data.percentage.toFixed(1)}%)
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
}

export function AssetAllocationChart({
  allocation,
  isLoading,
  singleAccountCurrency,
  holdingsByAccount,
  titleSuffix,
  accountIds,
  enableTagGrouping = true,
}: AssetAllocationChartProps) {
  const t = useTranslations('investments');
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();

  const [groupBy, setGroupBy] = useState<GroupBy>('security');
  // By-tag and by-country data cached per account-filter key so toggling back
  // and forth (or re-selecting the same accounts) does not refetch. Both are
  // fetched eagerly so we know which selectors to offer before the user acts:
  // the tag toggle only appears when tagged holdings exist, and the country
  // toggle only when the selected accounts carry country allocation data.
  const [tagCache, setTagCache] = useState<Record<string, AssetAllocation>>({});
  const [countryCache, setCountryCache] = useState<
    Record<string, CountryWeightingResult>
  >({});
  // KEY:VALUE aggregation: the available keys per account-filter, the key the
  // user picked, and the by-key allocation cached per `accountKey|key`.
  const [tagKeysCache, setTagKeysCache] = useState<Record<string, string[]>>({});
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

      investmentsApi
        .getPortfolioTagKeys(ids)
        .then((keys) => {
          if (!cancelled)
            setTagKeysCache((prev) => ({ ...prev, [accountKey]: keys }));
        })
        .catch(() => {
          if (!cancelled)
            setTagKeysCache((prev) => ({ ...prev, [accountKey]: [] }));
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
            [accountKey]: {
              items: [],
              totalPortfolioValue: 0,
              totalDirectValue: 0,
              totalEtfValue: 0,
              unclassifiedValue: 0,
            },
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

  // A selector is only offered once its data confirms it is meaningful for the
  // currently selected accounts: tags in use, or classified country exposure.
  const tagsAvailable =
    enableTagGrouping &&
    (tagCache[accountKey]?.allocation.some((i) => i.type === 'tag') ?? false);
  const countryAvailable = (countryResult?.items.length ?? 0) > 0;

  // KEY:VALUE aggregation: keys present for this account filter and the key the
  // chart is currently aggregating by (the user's pick, or the first key).
  const availableKeys = enableTagGrouping ? (tagKeysCache[accountKey] ?? []) : [];
  const keysAvailable = availableKeys.length > 0;
  const resolvedKey =
    selectedKey && availableKeys.includes(selectedKey)
      ? selectedKey
      : (availableKeys[0] ?? null);
  const tagKeyCacheKey = resolvedKey ? `${accountKey}|${resolvedKey}` : null;

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
          : groupBy;

  const isTagView = effectiveGroupBy === 'tag';
  const isTagKeyView = effectiveGroupBy === 'tagKey';
  const isCountryView = effectiveGroupBy === 'country';
  const activeAllocation = isTagView
    ? (tagCache[accountKey] ?? null)
    : isTagKeyView
      ? (tagKeyCacheKey ? (tagKeyCache[tagKeyCacheKey] ?? null) : null)
      : isCountryView
        ? countryAllocation
        : allocation;
  const activeLoading = isTagView
    ? !tagCache[accountKey]
    : isTagKeyView
      ? !tagKeyCacheKey || !tagKeyCache[tagKeyCacheKey]
      : isCountryView
        ? !countryResult
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
        color: item.color || '#6b7280',
        currencyCode: item.currencyCode,
      };
    });
  }, [activeAllocation, t]);

  // Security/tag legends cap at the top 10 slices; the country view is already
  // bounded to 10 countries plus "Other Countries", so show all of them.
  const legendData = isCountryView ? chartData : chartData.slice(0, 10);

  const showToggle = tagsAvailable || keysAvailable || countryAvailable;
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
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
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

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[420px]">
      {heading}
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
      <div className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2">
        {legendData.map((item, index) => {
          const isForeign = !foreignCurrency && item.currencyCode && item.currencyCode !== defaultCurrency;
          return (
            <div key={index} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-gray-600 dark:text-gray-400 truncate">
                {item.name}
                {isForeign && (
                  <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">({item.currencyCode})</span>
                )}
              </span>
              <span className="text-gray-900 dark:text-gray-100 ml-auto">
                {item.percentage.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
