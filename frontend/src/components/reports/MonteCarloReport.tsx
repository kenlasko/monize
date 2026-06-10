'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useRouter } from 'next/navigation';
import {
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Legend,
  ReferenceDot,
  ReferenceLine,
} from 'recharts';
import {
  monteCarloApi,
  AccountHoldingStats,
  CashFlowType,
} from '@/lib/monte-carlo';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getCurrencySymbol } from '@/lib/format';
import { showErrorToast } from '@/lib/errors';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MonteCarloSaveAsDialog } from './MonteCarloSaveAsDialog';
import {
  CashFlowEvent,
  CashFlowLegendSwatch,
  CashFlowMarker,
  FanChartTooltip,
} from './MonteCarloChartParts';
import { ResultsTable, SummaryStat } from './MonteCarloResultsTable';
import {
  PERFORMANCE_SUMMARY_HEADERS,
  PerformanceSummaryTable,
  buildPerformanceSummaryRows,
  formatSummaryValue,
} from './MonteCarloPerformanceSummary';
import { HoldingStatsTable } from './MonteCarloHoldingStatsTable';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { createLogger } from '@/lib/logger';
import { chartColors } from '@/lib/chart-colors';
import { useMonteCarloScenarios, MAX_COMPARE_SCENARIOS } from './useMonteCarloScenarios';
import { useTranslations } from 'next-intl';

const logger = createLogger('MonteCarloReport');

export function MonteCarloReport() {
  const t = useTranslations('reports');
  const { formatCurrency, formatCurrencyLabel, defaultCurrency } = useNumberFormat();
  const currencySymbol = useMemo(() => getCurrencySymbol(defaultCurrency), [defaultCurrency]);
  const {
    accounts,
    scenarios,
    activeId,
    result,
    form,
    isLoading,
    isRunning,
    savedFlash,
    showDeleteConfirm,
    showSaveAsDialog,
    pendingOverwriteName,
    updateField,
    addCashFlow,
    updateCashFlow,
    removeCashFlow,
    loadScenario,
    newScenario,
    run: runScenario,
    save,
    openSaveAsDialog,
    handleSaveAsSubmit,
    cancelSaveAs,
    performOverwrite,
    cancelOverwrite,
    requestDelete,
    confirmDelete,
    cancelDelete,
    reorderScenarios,
    selectMode,
    selectedForCompare,
    toggleSelectMode,
    toggleForCompare,
  } = useMonteCarloScenarios();
  const router = useRouter();
  const [reordering, setReordering] = useState(false);

  const moveScenario = useCallback(
    (index: number, direction: -1 | 1) => {
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= scenarios.length) return;
      const reordered = [...scenarios];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(newIndex, 0, moved);
      void reorderScenarios(reordered.map((s) => s.id));
    },
    [scenarios, reorderScenarios],
  );

  // The inputs panel collapses automatically after a fresh simulation run
  // (so the output is visible without scrolling) and after that respects the
  // user's manual toggle, persisted across scenario switches and reloads.
  const INPUTS_COLLAPSED_KEY = 'monize-monte-carlo-inputs-collapsed';
  const [inputsCollapsed, setInputsCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(INPUTS_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(INPUTS_COLLAPSED_KEY, inputsCollapsed ? '1' : '0');
    } catch {
      /* ignore quota / privacy errors */
    }
  }, [inputsCollapsed]);

  const [holdingStats, setHoldingStats] = useState<AccountHoldingStats[] | null>(null);
  const [holdingStatsLoading, setHoldingStatsLoading] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(saveMenuRef, () => setSaveMenuOpen(false), { enabled: saveMenuOpen });
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');
  const chartRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async () => {
    const ok = await runScenario();
    // After a fresh run, surface the results without scrolling. Subsequent
    // toggles by the user are persisted, so this only fires when they
    // actively click Run.
    if (ok) setInputsCollapsed(true);
  }, [runScenario]);


  // Fetch per-holding historical stats for the selected accounts whenever the
  // user is in historical-returns mode. Cleared otherwise so the table doesn't
  // show stale data after a mode toggle.
  useEffect(() => {
    if (!form.useHistoricalReturns || form.accountIds.length === 0) {
      setHoldingStats(null);
      return;
    }
    let cancelled = false;
    setHoldingStatsLoading(true);
    monteCarloApi
      .holdingStats(form.accountIds)
      .then((stats) => {
        if (!cancelled) setHoldingStats(stats);
      })
      .catch((err) => {
        if (!cancelled) {
          logger.error('Failed to fetch holding stats:', err);
          showErrorToast(err, t('monteCarlo.toasts.holdingStatsFailed'));
          setHoldingStats(null);
        }
      })
      .finally(() => {
        if (!cancelled) setHoldingStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.useHistoricalReturns, form.accountIds, t]);


  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;

  const accountOptions = useMemo(
    () =>
      accounts.map((a) => ({
        value: a.id,
        label: `${a.name} (${a.currencyCode})`,
      })),
    [accounts],
  );

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.yearLabels.map((label, i) => ({
      year: label,
      p10: result.percentiles.p10[i],
      p25: result.percentiles.p25[i],
      p50: result.percentiles.p50[i],
      p75: result.percentiles.p75[i],
      p90: result.percentiles.p90[i],
      // For the area band display: rendered from low-to-high stacked
      band10to25: result.percentiles.p25[i] - result.percentiles.p10[i],
      band25to75: result.percentiles.p75[i] - result.percentiles.p25[i],
      band75to90: result.percentiles.p90[i] - result.percentiles.p75[i],
    }));
  }, [result]);

  // Cash-flow markers: for each user-defined event, plot one dot at the
  // first year it fires and (for recurring events with a defined end) one
  // dot at the last year. Plotted on the median line so they sit visually
  // on the trajectory.
  type CashFlowMarkerData = CashFlowEvent & { year: string; yValue: number };
  const cashFlowMarkers = useMemo<CashFlowMarkerData[]>(() => {
    if (!result) return [];
    const totalYears = result.yearLabels.length;
    const markers: CashFlowMarkerData[] = [];
    for (const cf of form.cashFlows) {
      if (!Number.isFinite(cf.amount) || cf.amount === 0) continue;
      const start = Math.max(1, num(cf.startYear) || 1);
      if (start > totalYears) continue;
      const startIdx = start - 1;
      const startLabel = result.yearLabels[startIdx];
      const startY = result.percentiles.p50[startIdx];
      const income = cf.amount > 0;
      const base: Omit<CashFlowMarkerData, 'role' | 'year' | 'yValue'> = {
        income,
        name: cf.name?.trim() || 'Cash flow',
        amount: cf.amount,
        flowType: cf.flowType,
        startYear: start,
        endYear: cf.endYear ?? null,
        inflationAdjust: cf.inflationAdjust,
      };
      markers.push({ ...base, role: 'start', year: startLabel, yValue: startY });
      if (cf.flowType === 'RECURRING') {
        const endRaw = cf.endYear == null ? totalYears : cf.endYear;
        const end = Math.min(totalYears, Math.max(start, endRaw));
        if (end > start) {
          const endIdx = end - 1;
          markers.push({
            ...base,
            role: 'end',
            year: result.yearLabels[endIdx],
            yValue: result.percentiles.p50[endIdx],
          });
        }
      }
    }
    return markers;
  }, [result, form.cashFlows]);

  const tableRows = useMemo(() => {
    if (!result) return [];
    return result.yearLabels.map((label, i) => ({
      year: label,
      p10: result.percentiles.p10[i],
      p25: result.percentiles.p25[i],
      p50: result.percentiles.p50[i],
      p75: result.percentiles.p75[i],
      p90: result.percentiles.p90[i],
      events: cashFlowMarkers.filter((m) => m.year === label),
    }));
  }, [result, cashFlowMarkers]);

  const handleExportCsv = useCallback(() => {
    if (!result) return;
    const header = [
      t('monteCarlo.csvColYear'),
      t('monteCarlo.csvCol10th'),
      t('monteCarlo.csvCol25th'),
      t('monteCarlo.csvColMedian'),
      t('monteCarlo.csvCol75th'),
      t('monteCarlo.csvCol90th'),
      t('monteCarlo.csvColEvents'),
    ];
    const eventLabel = (m: CashFlowMarkerData) => {
      // One-time events only ever produce a single marker (role 'start');
      // showing "Start:" reads weird for those, so just print the name.
      const prefix =
        m.flowType === 'ONE_TIME'
          ? ''
          : m.role === 'start'
            ? t('monteCarlo.cashFlowEventStart')
            : t('monteCarlo.cashFlowEventEnd');
      return `${prefix}${m.name} (${m.income ? '+' : ''}${m.amount}${
        m.flowType === 'RECURRING' ? t('monteCarlo.cashFlowPerYear') : ''
      })`;
    };
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      escape(t('monteCarlo.csvTitle')),
      header.map(escape).join(','),
      ...tableRows.map((row) =>
        [
          row.year,
          row.p10.toFixed(2),
          row.p25.toFixed(2),
          row.p50.toFixed(2),
          row.p75.toFixed(2),
          row.p90.toFixed(2),
          escape(row.events.map(eventLabel).join('; ')),
        ].join(','),
      ),
    ];
    if (result.performanceSummary) {
      const summaryRows = buildPerformanceSummaryRows(result.performanceSummary);
      lines.push('');
      lines.push(escape(t('monteCarlo.csvPerformanceSummary')));
      lines.push(PERFORMANCE_SUMMARY_HEADERS.map(escape).join(','));
      for (const row of summaryRows) {
        lines.push(
          [
            escape(row.label),
            escape(formatSummaryValue(row.band.p10, row.format, formatCurrency)),
            escape(formatSummaryValue(row.band.p25, row.format, formatCurrency)),
            escape(formatSummaryValue(row.band.p50, row.format, formatCurrency)),
            escape(formatSummaryValue(row.band.p75, row.format, formatCurrency)),
            escape(formatSummaryValue(row.band.p90, row.format, formatCurrency)),
          ].join(','),
        );
      }
    }
    const blob = new Blob(['﻿' + lines.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monte-carlo-${(form.name || 'scenario').toLowerCase().replace(/\s+/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [result, tableRows, form.name, formatCurrency, t]);

  const handleExportPdf = useCallback(async () => {
    if (!result) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: `Monte Carlo: ${form.name || t('monteCarlo.untitledScenario')}`,
      subtitle: result.realValues
        ? t('monteCarlo.pdfSubtitleRealValues', { currency: defaultCurrency })
        : t('monteCarlo.pdfSubtitleNominalValues', { currency: defaultCurrency }),
      summaryCards: [
        {
          label: t('monteCarlo.pdfMedianFinal'),
          value: formatCurrency(result.finalDistribution.median),
          color: '#111827',
        },
        {
          label: t('monteCarlo.pdfRange10to90'),
          value: `${formatCurrency(
            result.percentiles.p10[result.percentiles.p10.length - 1] ?? 0,
          )} – ${formatCurrency(
            result.percentiles.p90[result.percentiles.p90.length - 1] ?? 0,
          )}`,
          color: '#111827',
          // Currency-range value is wider than the others; give it ~1.33x
          // the column width so it doesn't truncate in the PDF without
          // crowding the probability cards beside it.
          widthRatio: 4 / 3,
        },
        {
          label: t('monteCarlo.probabilityOfDepletion'),
          value: `${(result.finalDistribution.depletionRate * 100).toFixed(1)}%`,
          color: '#dc2626',
        },
        {
          label:
            form.targetValue != null && Number.isFinite(form.targetValue)
              ? t('monteCarlo.probabilityAboveTargetValue', { target: formatCurrency(form.targetValue) })
              : t('monteCarlo.probabilityAboveTarget'),
          value:
            result.successRate == null
              ? '—'
              : `${(result.successRate * 100).toFixed(1)}%`,
          color: '#16a34a',
        },
      ],
      // Always include the chart in the PDF, even when the on-screen view is
      // the table — the chart container stays mounted offscreen so the
      // ResponsiveContainer has real dimensions for html2canvas to capture.
      chartContainer: chartRef.current,
      additionalTables: [
        ...(result.performanceSummary
          ? [
              {
                title: t('monteCarlo.pdfPerformanceSummaryTitle'),
                headers: PERFORMANCE_SUMMARY_HEADERS,
                rows: buildPerformanceSummaryRows(result.performanceSummary).map(
                  (row) => [
                    row.label,
                    formatSummaryValue(row.band.p10, row.format, formatCurrency),
                    formatSummaryValue(row.band.p25, row.format, formatCurrency),
                    formatSummaryValue(row.band.p50, row.format, formatCurrency),
                    formatSummaryValue(row.band.p75, row.format, formatCurrency),
                    formatSummaryValue(row.band.p90, row.format, formatCurrency),
                  ],
                ),
              },
            ]
          : []),
        {
          title: t('monteCarlo.pdfYearlyTitle'),
          headers: [t('monteCarlo.pdfYearlyYear'), '10%', '25%', 'Median', '75%', '90%', t('monteCarlo.csvColEvents')],
          rows: tableRows.map((r) => [
            r.year,
            formatCurrency(r.p10),
            formatCurrency(r.p25),
            formatCurrency(r.p50),
            formatCurrency(r.p75),
            formatCurrency(r.p90),
            r.events
              .map((e) => {
                const prefix =
                  e.flowType === 'ONE_TIME'
                    ? ''
                    : e.role === 'start'
                      ? t('monteCarlo.cashFlowEventPdfStarts')
                      : t('monteCarlo.cashFlowEventPdfEnds');
                return `${prefix}${e.name} (${e.income ? '+' : ''}${formatCurrency(
                  e.amount,
                )}${e.flowType === 'RECURRING' ? t('monteCarlo.cashFlowPerYear') : ''})`;
              })
              .join('; '),
          ]),
        },
      ],
      filename: `monte-carlo-${(form.name || 'scenario').toLowerCase().replace(/\s+/g, '-')}`,
    });
  }, [
    result,
    form.name,
    form.targetValue,
    formatCurrency,
    defaultCurrency,
    tableRows, t,
  ]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
      {/* Left: scenarios */}
      <aside className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 h-fit">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{t('monteCarlo.scenarios')}</h3>
          <div className="flex items-center gap-1">
            {scenarios.length > 1 && !selectMode && (
              <button
                type="button"
                onClick={() => setReordering((v) => !v)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  reordering
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
                title={reordering ? t('monteCarlo.doneReordering') : t('monteCarlo.reorder')}
              >
                {reordering ? t('monteCarlo.doneBtn') : t('monteCarlo.reorder')}
              </button>
            )}
            {!selectMode && (
              <Button size="sm" variant="outline" onClick={newScenario}>
                {t('monteCarlo.newBtn')}
              </Button>
            )}
          </div>
        </div>
        {scenarios.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('monteCarlo.noScenarios')}
          </p>
        ) : (
          <ul className="space-y-1">
            {scenarios.map((s, index) => (
              <li key={s.id} className="flex items-center gap-1">
                {reordering && (
                  <div className="flex flex-col gap-0.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => moveScenario(index, -1)}
                      disabled={index === 0}
                      className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title={t('monteCarlo.reorderMoveUp')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => moveScenario(index, 1)}
                      disabled={index === scenarios.length - 1}
                      className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title={t('monteCarlo.reorderMoveDown')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                  </div>
                )}
                {selectMode ? (
                  <label
                    className={`flex-1 flex items-start gap-2 px-2 py-1.5 rounded text-sm cursor-pointer ${
                      selectedForCompare.has(s.id)
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-gray-900 dark:text-gray-100'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 flex-shrink-0"
                      checked={selectedForCompare.has(s.id)}
                      onChange={() => toggleForCompare(s.id)}
                      aria-label={t('monteCarlo.selectForComparison', { name: s.name })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{s.name}</div>
                      {s.lastRunAt && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t('monteCarlo.lastRun', { date: new Date(s.lastRunAt).toLocaleDateString() })}
                        </div>
                      )}
                    </div>
                  </label>
                ) : (
                  <button
                    onClick={() => !reordering && loadScenario(s)}
                    className={`flex-1 text-left px-2 py-1.5 rounded text-sm ${
                      reordering ? 'cursor-default' : ''
                    } ${
                      activeId === s.id
                        ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-200'
                        : reordering
                          ? 'text-gray-700 dark:text-gray-300'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <div className="font-medium truncate">{s.name}</div>
                    {s.lastRunAt && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {t('monteCarlo.lastRun', { date: new Date(s.lastRunAt).toLocaleDateString() })}
                      </div>
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {scenarios.length >= 2 && !reordering && (
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
            {selectMode ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  className="w-full"
                  disabled={selectedForCompare.size < 2}
                  onClick={() => {
                    const ids = Array.from(selectedForCompare);
                    router.push(
                      `/reports/monte-carlo-simulation/compare?ids=${ids.join(',')}`,
                    );
                  }}
                  title={
                    selectedForCompare.size < 2
                      ? t('monteCarlo.selectAtLeast2')
                      : t('monteCarlo.compareSelectedTitle')
                  }
                >
                  {t('monteCarlo.compareSelected', { count: selectedForCompare.size, max: MAX_COMPARE_SCENARIOS })}
                </Button>
                <button
                  type="button"
                  onClick={toggleSelectMode}
                  className="w-full text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  {t('monteCarlo.cancelSelectMode')}
                </button>
              </>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="w-full"
                onClick={toggleSelectMode}
                title={t('monteCarlo.compareBtn')}
              >
                {t('monteCarlo.compareBtn')}
              </Button>
            )}
          </div>
        )}
      </aside>

      {/* Right: form + results */}
      <section className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
          <div className="flex items-center justify-between gap-3 p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="min-w-0 flex-1">
              {inputsCollapsed ? (
                <div className="flex flex-col min-w-0">
                  <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {form.name || t('monteCarlo.untitledScenario')}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    <span>{t('monteCarlo.collapsedStart')} {formatCurrency(form.startingValue)}</span>
                    <span>
                      {t('monteCarlo.collapsedContribWithdraw', { contrib: form.yearsToRetirement, withdraw: form.yearsInRetirement })}
                    </span>
                    <span>
                      {form.useHistoricalReturns
                        ? t('monteCarlo.collapsedHistoricalReturns')
                        : t('monteCarlo.collapsedCustomReturns', { return: (form.expectedReturn * 100).toFixed(1), vol: (form.volatility * 100).toFixed(1) })}
                    </span>
                    <span>{t('monteCarlo.collapsedRuns', { count: form.simulationCount.toLocaleString() })}</span>
                  </div>
                </div>
              ) : (
                <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('monteCarlo.scenarioInputs')}
                </h2>
              )}
            </div>
            {inputsCollapsed && (
              <Button
                onClick={run}
                disabled={isRunning || form.accountIds.length === 0}
                variant="primary"
              >
                {isRunning ? t('monteCarlo.running') : t('monteCarlo.runAgain')}
              </Button>
            )}
            <button
              type="button"
              onClick={() => setInputsCollapsed((v) => !v)}
              aria-expanded={!inputsCollapsed}
              aria-controls="mc-inputs-body"
              className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {inputsCollapsed ? t('monteCarlo.editInputs') : t('monteCarlo.hideInputs')}
              <ChevronDownIcon
                className={`h-4 w-4 transition-transform ${inputsCollapsed ? '' : 'rotate-180'}`}
              />
            </button>
          </div>
          {!inputsCollapsed && (
            <div id="mc-inputs-body" className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('monteCarlo.scenarioName')}
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder={t('monteCarlo.scenarioNamePlaceholder')}
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm"
              />
            </div>
            <MultiSelect
              label={t('monteCarlo.investmentAccounts')}
              options={accountOptions}
              value={form.accountIds}
              onChange={(v) => updateField('accountIds', v)}
              placeholder={t('monteCarlo.selectAccountsPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label={t('monteCarlo.startingValue')}
              value={form.startingValue}
              onChange={(v) => updateField('startingValue', v ?? 0)}
              allowNegative={false}
              prefix={currencySymbol}
              disabled={form.useCurrentBalance}
            />
            <div className="flex items-center">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <ToggleSwitch
                  checked={form.useCurrentBalance}
                  onChange={(v) => updateField('useCurrentBalance', v)}
                  label={t('monteCarlo.useCurrentBalance')}
                />
                {t('monteCarlo.useCurrentBalance')}
              </label>
            </div>
          </div>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('monteCarlo.contributionPhase')}
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumericInput
                label={t('monteCarlo.yearsLabel')}
                value={form.yearsToRetirement}
                onChange={(v) => updateField('yearsToRetirement', Math.max(0, v ?? 0))}
                decimalPlaces={0}
                min={0}
              />
              <CurrencyInput
                label={t('monteCarlo.annualContribution')}
                value={form.annualContribution}
                onChange={(v) => updateField('annualContribution', v ?? 0)}
                allowNegative={false}
                prefix={currencySymbol}
              />
              <NumericInput
                label={t('monteCarlo.contributionGrowth')}
                value={form.contributionGrowthRate * 100}
                onChange={(v) =>
                  updateField('contributionGrowthRate', (v ?? 0) / 100)
                }
                decimalPlaces={2}
                allowNegative
                suffix="%"
              />
            </div>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('monteCarlo.withdrawalPhase')}
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumericInput
                label={t('monteCarlo.yearsLabel')}
                value={form.yearsInRetirement}
                onChange={(v) => updateField('yearsInRetirement', Math.max(0, v ?? 0))}
                decimalPlaces={0}
                min={0}
              />
              <CurrencyInput
                label={t('monteCarlo.annualWithdrawal')}
                value={form.annualWithdrawal}
                onChange={(v) => updateField('annualWithdrawal', v ?? 0)}
                allowNegative={false}
                prefix={currencySymbol}
              />
              <CurrencyInput
                label={t('monteCarlo.targetTodayValue')}
                value={form.targetValue ?? undefined}
                onChange={(v) => updateField('targetValue', v ?? null)}
                allowNegative={false}
                prefix={currencySymbol}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              {t('monteCarlo.withdrawalNote')}
            </p>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('monteCarlo.additionalCashFlows')}
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t('monteCarlo.cashFlowsNote')}
            </p>
            {form.cashFlows.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                {t('monteCarlo.noCashFlows')}
              </p>
            ) : (
              <div className="space-y-2 mb-3">
                {form.cashFlows.map((cf, idx) => (
                  <div
                    key={idx}
                    className="border border-gray-200 dark:border-gray-700 rounded-md p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-end"
                  >
                    <div className="md:col-span-3">
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        {t('monteCarlo.cashFlowName')}
                      </label>
                      <input
                        type="text"
                        value={cf.name}
                        onChange={(e) =>
                          updateCashFlow(idx, { name: e.target.value })
                        }
                        placeholder={t('monteCarlo.cashFlowNamePlaceholder')}
                        className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm text-sm"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <CurrencyInput
                        label={t('monteCarlo.cashFlowAmount')}
                        value={cf.amount}
                        onChange={(v) =>
                          updateCashFlow(idx, { amount: v ?? 0 })
                        }
                        allowNegative
                        prefix={currencySymbol}
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                        {t('monteCarlo.cashFlowType')}
                      </label>
                      <select
                        value={cf.flowType}
                        onChange={(e) =>
                          updateCashFlow(idx, {
                            flowType: e.target.value as CashFlowType,
                          })
                        }
                        className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm text-sm"
                      >
                        <option value="ONE_TIME">{t('monteCarlo.cashFlowTypeOneTime')}</option>
                        <option value="RECURRING">{t('monteCarlo.cashFlowTypeRecurring')}</option>
                      </select>
                    </div>
                    <div className="md:col-span-1">
                      <NumericInput
                        label={t('monteCarlo.cashFlowStart')}
                        value={cf.startYear}
                        onChange={(v) =>
                          updateCashFlow(idx, {
                            startYear: Math.max(1, v ?? 1),
                          })
                        }
                        decimalPlaces={0}
                        min={1}
                      />
                    </div>
                    {cf.flowType === 'RECURRING' && (
                      <div className="md:col-span-1">
                        <NumericInput
                          label={t('monteCarlo.cashFlowEnd')}
                          value={cf.endYear ?? undefined}
                          onChange={(v) =>
                            updateCashFlow(idx, {
                              endYear: v == null ? null : Math.max(cf.startYear, v),
                            })
                          }
                          decimalPlaces={0}
                          min={cf.startYear}
                        />
                      </div>
                    )}
                    <div
                      className={`${cf.flowType === 'RECURRING' ? 'md:col-span-3' : 'md:col-span-4'}`}
                    >
                      {/* Spacer mirroring the labeled inputs' label so the
                          toggle / trash row sits at the same vertical
                          position as the input fields when items-end on
                          the parent aligns the cell bottoms. */}
                      <div
                        aria-hidden="true"
                        className="block text-xs font-medium mb-1 select-none invisible"
                      >
                        {t('monteCarlo.cashFlowInflate')}
                      </div>
                      <div className="flex items-center gap-2 h-[2.375rem]">
                        <label className="inline-flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                          <ToggleSwitch
                            checked={cf.inflationAdjust}
                            onChange={(v) =>
                              updateCashFlow(idx, { inflationAdjust: v })
                            }
                            label={t('monteCarlo.cashFlowInflate')}
                          />
                          {t('monteCarlo.cashFlowInflate')}
                        </label>
                        <button
                          type="button"
                          onClick={() => removeCashFlow(idx)}
                          aria-label={t('monteCarlo.removeCashFlow')}
                          title={t('monteCarlo.removeTitle')}
                          className="ml-auto inline-flex items-center justify-center h-8 w-8 rounded-md text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.75}
                            stroke="currentColor"
                            className="h-4 w-4"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={addCashFlow}>
              {t('monteCarlo.addCashFlow')}
            </Button>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('monteCarlo.returnAssumptions')}
            </legend>
            <div className="flex flex-wrap gap-4 mb-3">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="returnMode"
                  checked={!form.useHistoricalReturns}
                  onChange={() => updateField('useHistoricalReturns', false)}
                />
                {t('monteCarlo.specifyReturn')}
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="returnMode"
                  checked={form.useHistoricalReturns}
                  onChange={() => updateField('useHistoricalReturns', true)}
                />
                {t('monteCarlo.useHistoricalReturns')}
              </label>
            </div>
            {form.useHistoricalReturns && (
              <>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  {t('monteCarlo.historicalNote')}
                </p>
                <HoldingStatsTable
                  data={holdingStats}
                  loading={holdingStatsLoading}
                  formatCurrency={formatCurrency}
                />
              </>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className={form.useHistoricalReturns ? 'opacity-50' : ''}>
                <NumericInput
                  label={t('monteCarlo.expectedReturn')}
                  value={form.expectedReturn * 100}
                  onChange={(v) => updateField('expectedReturn', (v ?? 0) / 100)}
                  decimalPlaces={2}
                  allowNegative
                  suffix="%"
                  disabled={form.useHistoricalReturns}
                />
              </div>
              <div className={form.useHistoricalReturns ? 'opacity-50' : ''}>
                <NumericInput
                  label={t('monteCarlo.volatility')}
                  value={form.volatility * 100}
                  onChange={(v) => updateField('volatility', (v ?? 0) / 100)}
                  decimalPlaces={2}
                  suffix="%"
                  disabled={form.useHistoricalReturns}
                />
              </div>
              <NumericInput
                label={t('monteCarlo.inflation')}
                value={form.inflationRate * 100}
                onChange={(v) => updateField('inflationRate', (v ?? 0) / 100)}
                decimalPlaces={2}
                allowNegative
                suffix="%"
              />
              <NumericInput
                label={t('monteCarlo.simulations')}
                value={form.simulationCount}
                onChange={(v) =>
                  updateField('simulationCount', Math.max(100, Math.min(50000, v ?? 5000)))
                }
                decimalPlaces={0}
                min={100}
              />
            </div>
            <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300 mt-3 cursor-pointer">
              <span className="shrink-0">
                <ToggleSwitch
                  checked={form.showRealValues}
                  onChange={(v) => updateField('showRealValues', v)}
                  label={t('monteCarlo.showRealValues')}
                />
              </span>
              <span className="flex-1">
                {t('monteCarlo.showRealValuesDesc')}
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {t('monteCarlo.appliesAfterRun')}
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={isRunning}>
              {isRunning ? t('monteCarlo.running') : t('monteCarlo.runSimulation')}
            </Button>
            {activeId ? (
              <div ref={saveMenuRef} className="relative inline-flex">
                <Button
                  variant={savedFlash ? 'primary' : 'outline'}
                  onClick={save}
                  disabled={savedFlash}
                  className={[
                    // "Save changes" is the longest label; keep that width fixed
                    // so the button doesn't reflow when it shows "Saved!".
                    'min-w-[8.25rem] justify-center rounded-r-none',
                    savedFlash
                      ? '!bg-green-600 hover:!bg-green-600 !border-green-600 !text-white !opacity-100'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {savedFlash ? t('monteCarlo.saved') : t('monteCarlo.saveChanges')}
                </Button>
                <Button
                  variant={savedFlash ? 'primary' : 'outline'}
                  onClick={() => setSaveMenuOpen((v) => !v)}
                  disabled={savedFlash}
                  aria-haspopup="menu"
                  aria-expanded={saveMenuOpen}
                  aria-label={t('monteCarlo.moreSaveOptions')}
                  className={[
                    'rounded-l-none border-l-0 px-2',
                    savedFlash
                      ? '!bg-green-600 hover:!bg-green-600 !border-green-600 !text-white !opacity-100'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <ChevronDownIcon className="h-4 w-4" />
                </Button>
                {saveMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSaveMenuOpen(false);
                        openSaveAsDialog();
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-md"
                    >
                      {t('monteCarlo.saveAs')}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Button
                variant={savedFlash ? 'primary' : 'outline'}
                onClick={save}
                disabled={savedFlash}
                className={[
                  'min-w-[8.25rem] justify-center',
                  savedFlash
                    ? '!bg-green-600 hover:!bg-green-600 !border-green-600 !text-white !opacity-100'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {savedFlash ? t('monteCarlo.saved') : t('monteCarlo.saveScenario')}
              </Button>
            )}
            {activeId && (
              <Button variant="danger" onClick={requestDelete}>
                {t('monteCarlo.deleteScenario')}
              </Button>
            )}
          </div>
            </div>
          )}
        </div>

        {result && (
          <div className="space-y-4">
            {/* 5-col grid: 1 + 2 + 1 + 1. Mobile stacks into 1 column,
                tablets into 2. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <SummaryStat
                label={t('monteCarlo.medianFinal')}
                value={formatCurrency(result.finalDistribution.median)}
              />
              <SummaryStat
                label={t('monteCarlo.percentile10to90')}
                value={`${formatCurrency(
                  result.percentiles.p10[result.percentiles.p10.length - 1] ?? 0,
                )} – ${formatCurrency(
                  result.percentiles.p90[result.percentiles.p90.length - 1] ?? 0,
                )}`}
                className="lg:col-span-2"
              />
              <SummaryStat
                label={t('monteCarlo.probabilityOfDepletion')}
                value={`${(result.finalDistribution.depletionRate * 100).toFixed(1)}%`}
              />
              <SummaryStat
                label={
                  form.targetValue != null && Number.isFinite(form.targetValue)
                    ? t('monteCarlo.probabilityAboveTargetValue', { target: formatCurrency(form.targetValue) })
                    : t('monteCarlo.probabilityAboveTarget')
                }
                value={
                  result.successRate == null
                    ? '—'
                    : `${(result.successRate * 100).toFixed(1)}%`
                }
              />
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                  {t('monteCarlo.projectedPortfolioValue')}{' '}
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                    {t('monteCarlo.projectedPortfolioSubtitle', { currency: defaultCurrency, valueType: result.realValues ? t('monteCarlo.realValues') : t('monteCarlo.nominalValues') })}
                  </span>
                </h3>
                <div className="ml-auto flex items-center gap-2">
                  <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden text-xs">
                    {(['chart', 'table'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setViewMode(m)}
                        className={`px-3 py-1 ${
                          viewMode === m
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {m === 'chart' ? t('monteCarlo.viewChart') : t('monteCarlo.viewTable')}
                      </button>
                    ))}
                  </div>
                  <ExportDropdown
                    onExportCsv={handleExportCsv}
                    onExportPdf={handleExportPdf}
                  />
                </div>
              </div>

              {/* Chart stays mounted whether or not it's the visible view, so
                  the PDF export always has a real DOM node to capture. When
                  the user is on the table tab the chart is positioned
                  offscreen rather than display:none (which would zero its
                  dimensions and produce a blank PDF image). */}
              <div
                ref={chartRef}
                className={
                  viewMode === 'chart'
                    ? 'h-80 w-full'
                    : 'absolute left-[-99999px] top-0 w-[800px] h-80 pointer-events-none'
                }
                aria-hidden={viewMode !== 'chart'}
              >
                <ResponsiveContainer>
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="year" />
                    <YAxis
                      tickFormatter={(v) => formatCurrencyLabel(Number(v))}
                      width={70}
                    />
                    <Tooltip
                      content={(props) => (
                        <FanChartTooltip
                          active={props.active}
                          payload={
                            props.payload as Array<{
                              payload?: Record<string, number>;
                            }>
                          }
                          label={String(props.label ?? '')}
                          fmt={formatCurrency}
                          events={cashFlowMarkers.filter(
                            (m) => m.year === String(props.label ?? ''),
                          )}
                        />
                      )}
                    />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="p10"
                      stackId="band"
                      stroke="none"
                      fill="transparent"
                      name={t('monteCarlo.chart10thPercentile')}
                    />
                    <Area
                      type="monotone"
                      dataKey="band10to25"
                      stackId="band"
                      stroke="none"
                      fill={chartColors.primary}
                      fillOpacity={0.3}
                      name={t('monteCarlo.chartBand10to25')}
                    />
                    <Area
                      type="monotone"
                      dataKey="band25to75"
                      stackId="band"
                      stroke="none"
                      fill={chartColors.primary}
                      fillOpacity={0.6}
                      name={t('monteCarlo.chartBand25to75')}
                    />
                    <Area
                      type="monotone"
                      dataKey="band75to90"
                      stackId="band"
                      stroke="none"
                      fill={chartColors.primary}
                      fillOpacity={0.3}
                      name={t('monteCarlo.chartBand75to90')}
                    />
                    <Line
                      type="monotone"
                      dataKey="p50"
                      stroke={chartColors.primary}
                      strokeWidth={2}
                      dot={false}
                      name={t('monteCarlo.chartMedian')}
                    />
                    {/* Phase divider: dotted vertical line at the last
                        contribution year so the user can see exactly where
                        accumulation ends and the withdrawal phase begins.
                        Skipped when the scenario has no contribution phase
                        or no withdrawal phase. */}
                    {form.yearsToRetirement > 0 &&
                      form.yearsInRetirement > 0 &&
                      result.yearLabels[form.yearsToRetirement - 1] !==
                        undefined && (
                        <ReferenceLine
                          x={result.yearLabels[form.yearsToRetirement - 1]}
                          stroke={chartColors.warning}
                          strokeDasharray="8 4"
                          strokeWidth={2.5}
                          label={{
                            // Arrow always points back to the divider line.
                            // Right-half divider -> label on left side ->
                            // arrow points right toward the line. Left-half
                            // divider -> label on right side -> arrow points
                            // left toward the line.
                            value:
                              form.yearsToRetirement /
                                result.yearLabels.length >
                              0.5
                                ? t('monteCarlo.withdrawalPhaseRight')
                                : t('monteCarlo.withdrawalPhaseLeft'),
                            // Recharts anchors the label text at the named
                            // position and the text flows away from that
                            // anchor, so 'insideTopRight' anchors on the
                            // right of the line and the text extends LEFT,
                            // and vice versa. When the divider sits in the
                            // right half of the chart we want the text on
                            // the left of the line (so it doesn't overflow
                            // the right edge), which means insideTopRight.
                            position:
                              form.yearsToRetirement /
                                result.yearLabels.length >
                              0.5
                                ? 'insideTopRight'
                                : 'insideTopLeft',
                            fill: chartColors.warning,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        />
                      )}
                    {cashFlowMarkers.map((m, i) => (
                      <ReferenceDot
                        key={`mk-${i}`}
                        x={m.year}
                        y={m.yValue}
                        r={6}
                        shape={(props: { cx?: number; cy?: number }) => (
                          <CashFlowMarker
                            cx={props.cx ?? 0}
                            cy={props.cy ?? 0}
                            role={m.role}
                            income={m.income}
                          />
                        )}
                        ifOverflow="extendDomain"
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              {viewMode === 'table' && (
                <ResultsTable
                  rows={tableRows}
                  formatCurrency={formatCurrency}
                />
              )}

              {cashFlowMarkers.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="start" income />
                    {t('monteCarlo.legendIncomeStarts')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="end" income />
                    {t('monteCarlo.legendIncomeEnds')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="start" income={false} />
                    {t('monteCarlo.legendExpenseStarts')}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="end" income={false} />
                    {t('monteCarlo.legendExpenseEnds')}
                  </span>
                </div>
              )}
            </div>

            {result.performanceSummary && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                  {t('monteCarlo.performanceSummaryTitle')}
                </h3>
                <PerformanceSummaryTable
                  summary={result.performanceSummary}
                  formatCurrency={formatCurrency}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title={t('monteCarlo.deleteConfirmTitle')}
        message={t('monteCarlo.deleteConfirmMessage', { name: form.name || t('monteCarlo.untitledScenario') })}
        confirmLabel={t('monteCarlo.confirmDelete')}
        cancelLabel={t('monteCarlo.cancelBtn')}
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />

      <MonteCarloSaveAsDialog
        isOpen={showSaveAsDialog}
        initialName={form.name}
        onCancel={cancelSaveAs}
        onSubmit={handleSaveAsSubmit}
      />

      <ConfirmDialog
        isOpen={pendingOverwriteName !== null}
        title={t('monteCarlo.overwriteConfirmTitle')}
        message={t('monteCarlo.overwriteConfirmMessage', { name: pendingOverwriteName ?? '' })}
        confirmLabel={t('monteCarlo.confirmOverwrite')}
        cancelLabel={t('monteCarlo.cancelBtn')}
        variant="warning"
        onConfirm={performOverwrite}
        onCancel={cancelOverwrite}
        pushHistory
      />
    </div>
  );
}
