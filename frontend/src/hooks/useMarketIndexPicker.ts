'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { MultiSelectOption } from '@/components/ui/MultiSelect';
import type { MarketIndex } from '@/types/investment';

/** Regions in the order the index picker groups them. */
const INDEX_REGIONS = ['NORTH_AMERICA', 'EUROPE', 'ASIA_PACIFIC'] as const;

/**
 * Marks a picker row as a region heading rather than an index. `MultiSelect`
 * puts a group's own value into the selection once every child is chosen, so
 * the two have to be told apart before the selection reaches the API.
 */
const INDEX_GROUP_PREFIX = 'region:';

/**
 * The market-index picker a performance chart overlays benchmarks from: its
 * grouped options, the raw selection the `MultiSelect` holds, and the index
 * codes that selection names once the region rows are stripped out.
 *
 * Shared by the Security Performance and Investment Performance reports so the
 * two offer the same catalog in the same order under the same names.
 */
export function useMarketIndexPicker(marketIndexes: readonly MarketIndex[]) {
  const t = useTranslations('reports');
  const ti = useTranslations('marketIndexes');
  const [selectedIndexCodes, setSelectedIndexCodes] = useState<string[]>([]);

  /** An index's localized name, falling back to what the catalog called it. */
  const indexName = useCallback(
    (code: string, fallback: string) => {
      const key = `names.${code}` as Parameters<typeof ti>[0];
      const localized = ti(key);
      return localized === key ? fallback : localized;
    },
    [ti],
  );

  /**
   * Benchmarks, grouped by region.
   *
   * **Every catalog entry is offered, including one we hold no prices for yet.**
   * Hiding those looked like courtesy and was a deadlock: an index's history is
   * fetched when it is first selected, so filtering on stored coverage meant a
   * fresh deployment showed an empty picker and nothing could ever fill it. The
   * comparison already answers an unpriced benchmark honestly -- it comes back
   * in `excluded` with a reason -- which is the right place for that to be
   * handled.
   */
  const indexOptions = useMemo<MultiSelectOption[]>(
    () =>
      INDEX_REGIONS.flatMap((region) => {
        const inRegion = marketIndexes
          .filter((index) => index.region === region)
          .sort((a, b) => a.defaultName.localeCompare(b.defaultName));
        if (inRegion.length === 0) return [];
        return [
          {
            value: `${INDEX_GROUP_PREFIX}${region}`,
            label: t(`securityPerformance.indexRegions.${region}` as Parameters<typeof t>[0]),
            children: inRegion.map((index) => ({
              value: index.code,
              label: indexName(index.code, index.defaultName),
            })),
          },
        ];
      }),
    [marketIndexes, t, indexName],
  );

  // The region rows are grouping, not instruments: sending `region:EUROPE` to
  // the API would be rejected as an unknown index code. The prefix is this
  // hook's own construction (see `indexOptions`), so stripping it needs no
  // catalog.
  const activeIndexCodes = useMemo(
    () => selectedIndexCodes.filter((code) => !code.startsWith(INDEX_GROUP_PREFIX)),
    [selectedIndexCodes],
  );

  return {
    indexOptions,
    selectedIndexCodes,
    setSelectedIndexCodes,
    activeIndexCodes,
    indexName,
  };
}
