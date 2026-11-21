'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AxiosError } from 'axios';
import { Button } from '@/components/ui/Button';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import {
  monteCarloApi,
  MonteCarloScenario,
  SimulationResult,
} from '@/lib/monte-carlo';
import {
  getCachedResult,
  setCachedResult,
} from '@/lib/monte-carlo-cache';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { exportToCsv } from '@/lib/csv-export';
import { MAX_COMPARE_SCENARIOS } from '../useMonteCarloScenarios';
import {
  CompareColumn,
  CompareMetricTable,
} from './CompareMetricTable';
import { ROW_GROUPS, formatCellValue } from './compareMetricRows';
import { CARD_CLASS } from '@/components/ui/Card';

const logger = createLogger('MonteCarloCompare');

type ColumnState = {
  status: CompareColumn['status'];
  scenario: MonteCarloScenario | null;
  result: SimulationResult | null;
  error?: string;
  fromCache?: boolean;
};

const initialColumnState = (id: string): ColumnState => {
  const cached = getCachedResult(id);
  return {
    status: 'loading',
    scenario: null,
    result: cached,
    fromCache: cached !== null,
  };
};

const is404 = (err: unknown): boolean =>
  err instanceof AxiosError && err.response?.status === 404;

export interface CompareScenariosViewProps {
  ids: string[];
}

export function CompareScenariosView({ ids }: CompareScenariosViewProps) {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const { formatDateTime } = useDateFormat();
  const neverLabel = t('monteCarloComparePage.never');
  // One bundle for the pure comparison module, which formats currency, counts,
  // percentages and run times, each in the reader's own locale and format.
  const cellFormatters = useMemo(
    () => ({ formatCurrency, formatNumber, formatPercent, formatInstant: formatDateTime, neverLabel }),
    [formatCurrency, formatNumber, formatPercent, formatDateTime, neverLabel],
  );

  const dedupedIds = useMemo(() => Array.from(new Set(ids)), [ids]);
  const truncated = ids.length > MAX_COMPARE_SCENARIOS;
  const effectiveIds = useMemo(
    () => dedupedIds.slice(0, MAX_COMPARE_SCENARIOS),
    [dedupedIds],
  );

  const [columnsById, setColumnsById] = useState<Record<string, ColumnState>>(
    () => {
      const initial: Record<string, ColumnState> = {};
      for (const id of effectiveIds) initial[id] = initialColumnState(id);
      return initial;
    },
  );

  // "Info from previous render" pattern — sync the columnsById keys with the
  // current effectiveIds without using setState inside an effect.
  const [trackedIds, setTrackedIds] = useState<string[]>(effectiveIds);
  if (trackedIds !== effectiveIds) {
    const sameSet =
      trackedIds.length === effectiveIds.length &&
      trackedIds.every((id, i) => id === effectiveIds[i]);
    if (!sameSet) {
      setTrackedIds(effectiveIds);
      setColumnsById((prev) => {
        const next: Record<string, ColumnState> = {};
        for (const id of effectiveIds) {
          next[id] = prev[id] ?? initialColumnState(id);
        }
        return next;
      });
    }
  }

  // Track which IDs we've already kicked off fetches for so we don't refetch
  // on every render. Reset when the URL changes the set of IDs.
  const fetchedIdsRef = useRef<Set<string>>(new Set());

  const updateColumn = useCallback(
    (id: string, patch: Partial<ColumnState>) => {
      setColumnsById((prev) => {
        const existing = prev[id];
        if (!existing) return prev;
        return { ...prev, [id]: { ...existing, ...patch } };
      });
    },
    [],
  );

  const fetchScenario = useCallback(
    async (id: string): Promise<MonteCarloScenario | null> => {
      try {
        return await monteCarloApi.get(id);
      } catch (err) {
        if (is404(err)) {
          updateColumn(id, {
            status: 'missing',
            scenario: null,
            result: null,
          });
          return null;
        }
        logger.error(`Failed to load scenario ${id}:`, err);
        updateColumn(id, {
          status: 'error',
          error: getErrorMessage(err, t('monteCarloComparePage.errors.loadScenarioFailed')),
        });
        return null;
      }
    },
    [updateColumn, t],
  );

  const runScenario = useCallback(
    async (id: string): Promise<void> => {
      try {
        const result = await monteCarloApi.runSaved(id);
        setCachedResult(id, result);
        updateColumn(id, {
          status: 'ok',
          result,
          fromCache: false,
          error: undefined,
        });
      } catch (err) {
        if (is404(err)) {
          updateColumn(id, {
            status: 'missing',
            scenario: null,
            result: null,
          });
          return;
        }
        logger.error(`Run failed for scenario ${id}:`, err);
        updateColumn(id, {
          status: 'error',
          error: getErrorMessage(err, t('monteCarloComparePage.errors.simulationFailed')),
        });
      }
    },
    [updateColumn, t],
  );

  // Bootstrap each new id: fetch metadata, mark cached state as ok, then run.
  useEffect(() => {
    // Drop any tracked fetches for ids no longer in scope so removed-then-
    // re-added scenarios refetch cleanly.
    const allowed = new Set(effectiveIds);
    for (const id of fetchedIdsRef.current) {
      if (!allowed.has(id)) fetchedIdsRef.current.delete(id);
    }
    for (const id of effectiveIds) {
      if (fetchedIdsRef.current.has(id)) continue;
      fetchedIdsRef.current.add(id);
      void (async () => {
        const scenario = await fetchScenario(id);
        if (!scenario) return;
        const cached = getCachedResult(id);
        if (cached) {
          // Show the cached result immediately and let the user re-run
          // explicitly. Mirrors the main report's load-cached-only behavior.
          updateColumn(id, {
            scenario,
            result: cached,
            fromCache: true,
            status: 'ok',
          });
          return;
        }
        updateColumn(id, { scenario, status: 'loading' });
        await runScenario(id);
      })();
    }
  }, [effectiveIds, fetchScenario, runScenario, updateColumn]);

  const updateUrlIds = useCallback(
    (nextIds: string[]) => {
      if (nextIds.length === 0) {
        router.replace('/reports/monte-carlo-simulation');
        return;
      }
      router.replace(
        `/reports/monte-carlo-simulation/compare?ids=${nextIds.join(',')}`,
      );
    },
    [router],
  );

  const handleRemove = useCallback(
    (id: string) => {
      updateUrlIds(effectiveIds.filter((x) => x !== id));
    },
    [effectiveIds, updateUrlIds],
  );

  const handleRetry = useCallback(
    (id: string) => {
      updateColumn(id, { status: 'loading', error: undefined });
      void runScenario(id);
    },
    [runScenario, updateColumn],
  );

  const handleRerun = useCallback(
    (id: string) => {
      updateColumn(id, { status: 'loading', error: undefined });
      void runScenario(id);
    },
    [runScenario, updateColumn],
  );

  if (effectiveIds.length === 0) {
    return <EmptyState />;
  }

  if (effectiveIds.length === 1) {
    return <NeedsMoreState id={effectiveIds[0]} />;
  }

  const columns: CompareColumn[] = effectiveIds.map((id) => {
    const state = columnsById[id] ?? initialColumnState(id);
    return {
      id,
      status: state.status,
      scenario: state.scenario,
      result: state.result,
      error: state.error,
      fromCache: state.fromCache,
    };
  });

  const exportableColumns = columns.filter(
    (c) => c.status === 'ok' && c.scenario && c.result,
  );
  const canExport = exportableColumns.length >= 2;

  const handleDownloadCsv = () => {
    const headers = [
      'Group',
      'Metric',
      ...exportableColumns.map((c) => c.scenario?.name ?? c.id),
    ];
    const rows: (string | number | boolean | null | undefined)[][] = [];
    for (const group of ROW_GROUPS) {
      for (const row of group.rows) {
        rows.push([
          group.label,
          row.label,
          ...exportableColumns.map((c) =>
            formatCellValue(
              row.accessor({ scenario: c.scenario!, result: c.result }),
              row.format,
              cellFormatters,
            ),
          ),
        ]);
      }
    }
    exportToCsv('monte-carlo-comparison', headers, rows);
  };

  return (
    <div className="space-y-4">
      {truncated && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3 text-sm text-amber-800 dark:text-amber-200">
          Showing the first {MAX_COMPARE_SCENARIOS} of {dedupedIds.length}{' '}
          scenarios. You can compare up to {MAX_COMPARE_SCENARIOS} at a time.
        </div>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownloadCsv}
          disabled={!canExport}
          title={
            canExport
              ? t('monteCarloComparePage.downloadCsvTitle')
              : t('monteCarloComparePage.downloadCsvWaitTitle')
          }
        >
          {t('monteCarloComparePage.downloadCsv')}
        </Button>
      </div>
      <CompareMetricTable
        columns={columns}
        formatters={cellFormatters}
        onRetry={handleRetry}
        onRemove={handleRemove}
        onRerun={handleRerun}
      />
    </div>
  );
}

function EmptyState() {
  const t = useTranslations('reports');
  return (
    <div className={`${CARD_CLASS} p-8 text-center space-y-3`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('monteCarloComparePage.emptyHeading')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t('monteCarloComparePage.emptyBody')}
      </p>
      <Link href="/reports/monte-carlo-simulation">
        <Button variant="primary">
          {t('monteCarloComparePage.emptyButton')}
        </Button>
      </Link>
    </div>
  );
}

function NeedsMoreState({ id }: { id: string }) {
  const t = useTranslations('reports');
  return (
    <div className={`${CARD_CLASS} p-8 text-center space-y-3`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('monteCarloComparePage.needsMoreHeading')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t.rich('monteCarloComparePage.needsMoreBody', {
          id,
          mono: (chunks) => (
            <span className="font-mono">{chunks}</span>
          ),
        })}
      </p>
      <Link href="/reports/monte-carlo-simulation">
        <Button variant="primary">
          {t('monteCarloComparePage.needsMoreButton')}
        </Button>
      </Link>
    </div>
  );
}
