'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  MonteCarloScenario,
  MonteCarloScenarioInputs,
  SimulationResult,
  AccountHoldingStats,
  CashFlow,
  CashFlowType,
} from '@/lib/monte-carlo';
import {
  getCachedResult,
  setCachedResult,
  clearCachedResult,
} from '@/lib/monte-carlo-cache';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getCurrencySymbol } from '@/lib/format';
import { showErrorToast } from '@/lib/errors';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { createLogger } from '@/lib/logger';

interface BrokerageAccount {
  id: string;
  name: string;
  currencyCode: string;
}

const logger = createLogger('MonteCarloReport');

const DEFAULT_INPUTS: MonteCarloScenarioInputs = {
  accountIds: [],
  startingValue: 0,
  useCurrentBalance: true,
  yearsToRetirement: 25,
  annualContribution: 12000,
  contributionGrowthRate: 0.02,
  yearsInRetirement: 30,
  annualWithdrawal: 60000,
  expectedReturn: 0.07,
  volatility: 0.15,
  inflationRate: 0.025,
  showRealValues: false,
  useHistoricalReturns: false,
  simulationCount: 5000,
};

type FormState = Omit<
  MonteCarloScenarioInputs,
  'targetValue' | 'randomSeed' | 'cashFlows'
> & {
  name: string;
  description: string;
  targetValue: number | null;
  randomSeed: string | null;
  cashFlows: CashFlow[];
};

const EMPTY_FORM: FormState = {
  ...DEFAULT_INPUTS,
  name: '',
  description: '',
  targetValue: null,
  randomSeed: null,
  cashFlows: [],
};

export function MonteCarloReport() {
  const { formatCurrency, formatCurrencyLabel, defaultCurrency } = useNumberFormat();
  const currencySymbol = useMemo(() => getCurrencySymbol(defaultCurrency), [defaultCurrency]);
  const [accounts, setAccounts] = useState<BrokerageAccount[]>([]);
  const [scenarios, setScenarios] = useState<MonteCarloScenario[]>([]);
  // Persist the last-active scenario id so a page refresh keeps the user
  // on the same scenario instead of dumping them back to an empty form.
  const ACTIVE_ID_KEY = 'monize-monte-carlo-active-id';
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(ACTIVE_ID_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (activeId) window.localStorage.setItem(ACTIVE_ID_KEY, activeId);
      else window.localStorage.removeItem(ACTIVE_ID_KEY);
    } catch {
      /* ignore quota / privacy errors */
    }
  }, [activeId]);
  // Persist simulation results to localStorage so the user doesn't have to
  // re-run the simulation after a page refresh. Only cache for saved scenarios
  // -- ad-hoc/draft results have no stable key.
  const [result, setResult] = useState<SimulationResult | null>(null);
  useEffect(() => {
    if (activeId && result) setCachedResult(activeId, result);
  }, [activeId, result]);
  // Collapse the input form whenever a result exists so the simulation
  // output is visible without scrolling. Re-expands when result is cleared
  // (e.g. New scenario, or loading a scenario without a cached result).
  const [inputsCollapsed, setInputsCollapsed] = useState(false);
  useEffect(() => {
    setInputsCollapsed(Boolean(result));
  }, [result]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [holdingStats, setHoldingStats] = useState<AccountHoldingStats[] | null>(null);
  const [holdingStatsLoading, setHoldingStatsLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [accs, scns] = await Promise.all([
          monteCarloApi.brokerageAccounts(),
          monteCarloApi.list(),
        ]);
        setAccounts(accs);
        setScenarios(scns);
        // Auto-restore the last-active scenario after a page refresh so the
        // user doesn't have to re-pick it from the sidebar each time. We
        // read localStorage directly here (not state) because state may not
        // have settled before this effect runs.
        const savedId =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(ACTIVE_ID_KEY)
            : null;
        if (savedId) {
          const match = scns.find((s) => s.id === savedId);
          if (match) {
            // Inline hydrate (don't call hydrateFormFromScenario here so the
            // effect doesn't capture it as a stale closure).
            setActiveId(match.id);
            setForm({
              name: match.name,
              description: match.description ?? '',
              accountIds: match.accountIds,
              startingValue: Number(match.startingValue),
              useCurrentBalance: match.useCurrentBalance,
              yearsToRetirement: match.yearsToRetirement,
              annualContribution: Number(match.annualContribution),
              contributionGrowthRate: Number(match.contributionGrowthRate),
              yearsInRetirement: match.yearsInRetirement,
              annualWithdrawal: Number(match.annualWithdrawal),
              expectedReturn: Number(match.expectedReturn),
              volatility: Number(match.volatility),
              inflationRate: Number(match.inflationRate),
              showRealValues: match.showRealValues,
              useHistoricalReturns: match.useHistoricalReturns,
              simulationCount: match.simulationCount,
              targetValue:
                match.targetValue == null ? null : Number(match.targetValue),
              randomSeed: match.randomSeed,
              cashFlows: (match.cashFlows ?? []).map((cf) => ({
                name: cf.name,
                amount: Number(cf.amount),
                flowType: cf.flowType,
                startYear: cf.startYear,
                endYear: cf.endYear ?? null,
                inflationAdjust: cf.inflationAdjust,
              })),
            });
            const cached = getCachedResult(match.id);
            if (cached) setResult(cached);
          } else {
            setActiveId(null);
          }
        }
      } catch (err) {
        logger.error('Failed to load Monte Carlo data:', err);
        showErrorToast(err, 'Failed to load Monte Carlo data. Please refresh.');
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

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
          showErrorToast(err, 'Failed to load per-holding historical stats.');
          setHoldingStats(null);
        }
      })
      .finally(() => {
        if (!cancelled) setHoldingStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.useHistoricalReturns, form.accountIds]);

  // Auto-populate the starting value when "Use current balance" is on. Refetches
  // when the selected accounts change so the displayed value matches what the
  // simulation will actually use.
  useEffect(() => {
    if (!form.useCurrentBalance || form.accountIds.length === 0) return;
    let cancelled = false;
    monteCarloApi
      .historicalStats(form.accountIds)
      .then((stats) => {
        if (cancelled) return;
        // NaN serializes to JSON null; guard against that and any other
        // non-numeric server quirks so we never feed null into a required
        // numeric form field.
        const safe =
          typeof stats.currentBalance === 'number' &&
          Number.isFinite(stats.currentBalance)
            ? stats.currentBalance
            : 0;
        setForm((prev) =>
          prev.useCurrentBalance &&
          prev.accountIds.length > 0 &&
          prev.accountIds.every((id) => form.accountIds.includes(id))
            ? { ...prev, startingValue: safe }
            : prev,
        );
      })
      .catch((err) => {
        logger.error('Failed to fetch current balance:', err);
        showErrorToast(err, 'Failed to fetch the current portfolio value.');
      });
    return () => {
      cancelled = true;
    };
  }, [form.useCurrentBalance, form.accountIds]);

  const updateField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const loadScenario = (s: MonteCarloScenario) => {
    setActiveId(s.id);
    setForm({
      name: s.name,
      description: s.description ?? '',
      accountIds: s.accountIds,
      startingValue: Number(s.startingValue),
      useCurrentBalance: s.useCurrentBalance,
      yearsToRetirement: s.yearsToRetirement,
      annualContribution: Number(s.annualContribution),
      contributionGrowthRate: Number(s.contributionGrowthRate),
      yearsInRetirement: s.yearsInRetirement,
      annualWithdrawal: Number(s.annualWithdrawal),
      expectedReturn: Number(s.expectedReturn),
      volatility: Number(s.volatility),
      inflationRate: Number(s.inflationRate),
      showRealValues: s.showRealValues,
      useHistoricalReturns: s.useHistoricalReturns,
      simulationCount: s.simulationCount,
      targetValue: s.targetValue == null ? null : Number(s.targetValue),
      randomSeed: s.randomSeed,
      cashFlows: (s.cashFlows ?? []).map((cf) => ({
        name: cf.name,
        amount: Number(cf.amount),
        flowType: cf.flowType,
        startYear: cf.startYear,
        endYear: cf.endYear ?? null,
        inflationAdjust: cf.inflationAdjust,
      })),
    });
    setResult(getCachedResult(s.id));
  };

  const newScenario = () => {
    setActiveId(null);
    setForm(EMPTY_FORM);
    setResult(null);
  };

  // Backend `@IsOptional()` decorators expect omission, not explicit null.
  // Build the payload without nullable fields when they have no value.
  // Coerce any non-finite numbers (NaN, ±Infinity, null/undefined leaking in
  // from API responses) to 0 so we never POST something class-validator will
  // reject as "not a number".
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;

  const inputsFromForm = (f: FormState): MonteCarloScenarioInputs => {
    const base = {
      accountIds: f.accountIds,
      startingValue: num(f.startingValue),
      useCurrentBalance: f.useCurrentBalance,
      yearsToRetirement: num(f.yearsToRetirement),
      annualContribution: num(f.annualContribution),
      contributionGrowthRate: num(f.contributionGrowthRate),
      yearsInRetirement: num(f.yearsInRetirement),
      annualWithdrawal: num(f.annualWithdrawal),
      expectedReturn: num(f.expectedReturn),
      volatility: num(f.volatility),
      inflationRate: num(f.inflationRate),
      showRealValues: f.showRealValues,
      useHistoricalReturns: f.useHistoricalReturns,
      simulationCount: num(f.simulationCount),
    };
    const targetValue =
      f.targetValue != null && Number.isFinite(f.targetValue)
        ? f.targetValue
        : null;
    // Keep every row the user has added; default the name when blank so the
    // backend's @IsNotEmpty validator doesn't reject the row. Rows are only
    // dropped when amount is non-numeric (e.g. mid-edit junk).
    const cashFlows: CashFlow[] = f.cashFlows
      .filter((cf) => Number.isFinite(cf.amount))
      .map((cf, idx) => ({
        name: cf.name.trim() || `Cash flow ${idx + 1}`,
        amount: cf.amount,
        flowType: cf.flowType,
        startYear: Math.max(1, num(cf.startYear) || 1),
        endYear:
          cf.flowType === 'RECURRING' && cf.endYear != null && Number.isFinite(cf.endYear)
            ? cf.endYear
            : null,
        inflationAdjust: !!cf.inflationAdjust,
      }));
    return {
      ...base,
      ...(targetValue != null ? { targetValue } : {}),
      ...(f.randomSeed ? { randomSeed: f.randomSeed } : {}),
      ...(cashFlows.length > 0 ? { cashFlows } : { cashFlows: [] }),
    } as MonteCarloScenarioInputs;
  };

  const addCashFlow = () => {
    setForm((prev) => ({
      ...prev,
      cashFlows: [
        ...prev.cashFlows,
        {
          name: '',
          amount: 0,
          flowType: 'ONE_TIME',
          startYear: 1,
          endYear: null,
          inflationAdjust: true,
        },
      ],
    }));
  };

  const updateCashFlow = (idx: number, patch: Partial<CashFlow>) => {
    setForm((prev) => ({
      ...prev,
      cashFlows: prev.cashFlows.map((cf, i) =>
        i === idx ? { ...cf, ...patch } : cf,
      ),
    }));
  };

  const removeCashFlow = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      cashFlows: prev.cashFlows.filter((_, i) => i !== idx),
    }));
  };

  const run = async () => {
    setIsRunning(true);
    try {
      // Always run with the *current* form values, not the saved scenario.
      // Otherwise editing a loaded scenario and clicking Run would silently
      // re-simulate the saved (stale) values.
      const r = await monteCarloApi.run(inputsFromForm(form));
      setResult(r);
    } catch (err) {
      logger.error('Simulation failed:', err);
      showErrorToast(err, 'Simulation failed. Check inputs and try again.');
    } finally {
      setIsRunning(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('Please enter a scenario name to save.');
      return;
    }
    try {
      const inputs = inputsFromForm(form);
      const payload = {
        ...inputs,
        name: form.name,
        description: form.description || undefined,
      };
      if (activeId) {
        const updated = await monteCarloApi.update(activeId, payload);
        setScenarios((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s)),
        );
        toast.success('Scenario saved.');
      } else {
        const created = await monteCarloApi.create(payload);
        setScenarios((prev) => [created, ...prev]);
        setActiveId(created.id);
        toast.success('Scenario created.');
      }
      // Flash the Save button green for ~2s as inline confirmation.
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      logger.error('Save failed:', err);
      showErrorToast(err, 'Could not save scenario.');
    }
  };

  const requestDelete = () => {
    if (!activeId) return;
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!activeId) {
      setShowDeleteConfirm(false);
      return;
    }
    try {
      await monteCarloApi.remove(activeId);
      clearCachedResult(activeId);
      setScenarios((prev) => prev.filter((s) => s.id !== activeId));
      newScenario();
      toast.success('Scenario deleted.');
    } catch (err) {
      logger.error('Delete failed:', err);
      showErrorToast(err, 'Could not delete scenario.');
    } finally {
      setShowDeleteConfirm(false);
    }
  };

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
  type CashFlowMarker = {
    year: string;
    yValue: number;
    role: 'start' | 'end';
    income: boolean;
    name: string;
    amount: number;
    flowType: CashFlowType;
    startYear: number;
    endYear?: number | null;
    inflationAdjust: boolean;
  };
  const cashFlowMarkers = useMemo<CashFlowMarker[]>(() => {
    if (!result) return [];
    const totalYears = result.yearLabels.length;
    const markers: CashFlowMarker[] = [];
    for (const cf of form.cashFlows) {
      if (!Number.isFinite(cf.amount) || cf.amount === 0) continue;
      const start = Math.max(1, num(cf.startYear) || 1);
      if (start > totalYears) continue;
      const startIdx = start - 1;
      const startLabel = result.yearLabels[startIdx];
      const startY = result.percentiles.p50[startIdx];
      const income = cf.amount > 0;
      const base: Omit<CashFlowMarker, 'role' | 'year' | 'yValue'> = {
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
      'Year',
      '10th percentile',
      '25th percentile',
      'Median (50th)',
      '75th percentile',
      '90th percentile',
      'Events',
    ];
    const eventLabel = (m: CashFlowMarker) => {
      // One-time events only ever produce a single marker (role 'start');
      // showing "Start:" reads weird for those, so just print the name.
      const prefix =
        m.flowType === 'ONE_TIME'
          ? ''
          : m.role === 'start'
            ? 'Start: '
            : 'End: ';
      return `${prefix}${m.name} (${m.income ? '+' : ''}${m.amount}${
        m.flowType === 'RECURRING' ? '/yr' : ''
      })`;
    };
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
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
  }, [result, tableRows, form.name]);

  const handleExportPdf = useCallback(async () => {
    if (!result) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: `Monte Carlo: ${form.name || 'Scenario'}`,
      subtitle: result.realValues
        ? `In ${defaultCurrency} (today's value)`
        : `In ${defaultCurrency} (nominal)`,
      summaryCards: [
        {
          label: 'Median final',
          value: formatCurrency(result.finalDistribution.median),
          color: '#111827',
        },
        {
          label: '10th–90th',
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
          label: 'Probability of Depletion',
          value: `${(result.finalDistribution.depletionRate * 100).toFixed(1)}%`,
          color: '#dc2626',
        },
        {
          label:
            form.targetValue != null && Number.isFinite(form.targetValue)
              ? `Probability Above Target (${formatCurrency(form.targetValue)})`
              : 'Probability Above Target',
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
      tableData: {
        headers: ['Year', '10%', '25%', 'Median', '75%', '90%', 'Events'],
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
                    ? 'Starts: '
                    : 'Ends: ';
              return `${prefix}${e.name} (${e.income ? '+' : ''}${formatCurrency(
                e.amount,
              )}${e.flowType === 'RECURRING' ? '/yr' : ''})`;
            })
            .join('; '),
        ]),
      },
      filename: `monte-carlo-${(form.name || 'scenario').toLowerCase().replace(/\s+/g, '-')}`,
    });
  }, [
    result,
    form.name,
    form.targetValue,
    formatCurrency,
    defaultCurrency,
    tableRows,
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
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">Scenarios</h3>
          <Button size="sm" variant="outline" onClick={newScenario}>
            New
          </Button>
        </div>
        {scenarios.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No saved scenarios. Configure inputs on the right and click Save.
          </p>
        ) : (
          <ul className="space-y-1">
            {scenarios.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => loadScenario(s)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm ${
                    activeId === s.id
                      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-200'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  <div className="font-medium truncate">{s.name}</div>
                  {s.lastRunAt && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Last run {new Date(s.lastRunAt).toLocaleDateString()}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Right: form + results */}
      <section className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
          <div className="flex items-center justify-between gap-3 p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="min-w-0 flex-1">
              {inputsCollapsed ? (
                <div className="flex flex-col min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {form.name || 'Untitled scenario'}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    <span>Start: {formatCurrency(form.startingValue)}</span>
                    <span>
                      {form.yearsToRetirement}y contrib /{' '}
                      {form.yearsInRetirement}y withdrawal
                    </span>
                    <span>
                      {form.useHistoricalReturns
                        ? 'Historical returns'
                        : `${(form.expectedReturn * 100).toFixed(1)}% return, ${(form.volatility * 100).toFixed(1)}% vol`}
                    </span>
                    <span>{form.simulationCount.toLocaleString()} runs</span>
                  </div>
                </div>
              ) : (
                <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Scenario inputs
                </h2>
              )}
            </div>
            {inputsCollapsed && (
              <Button
                onClick={run}
                disabled={isRunning || form.accountIds.length === 0}
                variant="primary"
              >
                {isRunning ? 'Running…' : 'Run again'}
              </Button>
            )}
            <button
              type="button"
              onClick={() => setInputsCollapsed((v) => !v)}
              aria-expanded={!inputsCollapsed}
              aria-controls="mc-inputs-body"
              className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {inputsCollapsed ? 'Edit inputs' : 'Hide inputs'}
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
                Scenario name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="e.g. Aggressive 25-year"
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm"
              />
            </div>
            <MultiSelect
              label="Investment accounts"
              options={accountOptions}
              value={form.accountIds}
              onChange={(v) => updateField('accountIds', v)}
              placeholder="Select accounts..."
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CurrencyInput
              label="Starting value"
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
                  label="Use current balance on each run"
                />
                Use current balance on each run
              </label>
            </div>
          </div>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              Contribution phase
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumericInput
                label="Years"
                value={form.yearsToRetirement}
                onChange={(v) => updateField('yearsToRetirement', Math.max(0, v ?? 0))}
                decimalPlaces={0}
                min={0}
              />
              <CurrencyInput
                label="Annual contribution"
                value={form.annualContribution}
                onChange={(v) => updateField('annualContribution', v ?? 0)}
                allowNegative={false}
                prefix={currencySymbol}
              />
              <NumericInput
                label="Contribution growth"
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
              Withdrawal phase
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <NumericInput
                label="Years"
                value={form.yearsInRetirement}
                onChange={(v) => updateField('yearsInRetirement', Math.max(0, v ?? 0))}
                decimalPlaces={0}
                min={0}
              />
              <CurrencyInput
                label="Annual withdrawal"
                value={form.annualWithdrawal}
                onChange={(v) => updateField('annualWithdrawal', v ?? 0)}
                allowNegative={false}
                prefix={currencySymbol}
              />
              <CurrencyInput
                label="Target (today's value)"
                value={form.targetValue ?? undefined}
                onChange={(v) => updateField('targetValue', v ?? null)}
                allowNegative={false}
                prefix={currencySymbol}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Annual withdrawal is in today&apos;s value and is grown by the
              inflation rate each year so purchasing power stays constant
              throughout the withdrawal phase. The success-rate target is also
              compared against each path&apos;s final value in today&apos;s
              terms.
            </p>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              Additional cash flows
            </legend>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              One-time or recurring inflows / outflows that layer on top of
              the base contribution and withdrawal phases. Use a positive
              amount for income (pension, sale proceeds, inheritance) and a
              negative amount for expenses (renovation, college, etc).
            </p>
            {form.cashFlows.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                No additional cash flows configured.
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
                        Name
                      </label>
                      <input
                        type="text"
                        value={cf.name}
                        onChange={(e) =>
                          updateCashFlow(idx, { name: e.target.value })
                        }
                        placeholder="e.g. Pension"
                        className="block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm text-sm"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <CurrencyInput
                        label="Amount"
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
                        Type
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
                        <option value="ONE_TIME">One-time</option>
                        <option value="RECURRING">Recurring</option>
                      </select>
                    </div>
                    <div className="md:col-span-1">
                      <NumericInput
                        label="Start"
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
                          label="End"
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
                        Inflate
                      </div>
                      <div className="flex items-center gap-2 h-[2.375rem]">
                        <label className="inline-flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                          <ToggleSwitch
                            checked={cf.inflationAdjust}
                            onChange={(v) =>
                              updateCashFlow(idx, { inflationAdjust: v })
                            }
                            label="Inflate"
                          />
                          Inflate
                        </label>
                        <button
                          type="button"
                          onClick={() => removeCashFlow(idx)}
                          aria-label="Remove cash flow"
                          title="Remove"
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
              + Add cash flow
            </Button>
          </fieldset>

          <fieldset className="border border-gray-200 dark:border-gray-700 rounded-md p-4">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              Return assumptions
            </legend>
            <div className="flex flex-wrap gap-4 mb-3">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="returnMode"
                  checked={!form.useHistoricalReturns}
                  onChange={() => updateField('useHistoricalReturns', false)}
                />
                Specify expected return
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="returnMode"
                  checked={form.useHistoricalReturns}
                  onChange={() => updateField('useHistoricalReturns', true)}
                />
                Use historical returns from selected accounts
              </label>
            </div>
            {form.useHistoricalReturns && (
              <>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  Mean and volatility are recomputed from the year-over-year
                  price history of the holdings in the selected accounts each
                  time you run. Inflation and simulation count below still
                  apply.
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
                  label="Expected return"
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
                  label="Volatility"
                  value={form.volatility * 100}
                  onChange={(v) => updateField('volatility', (v ?? 0) / 100)}
                  decimalPlaces={2}
                  suffix="%"
                  disabled={form.useHistoricalReturns}
                />
              </div>
              <NumericInput
                label="Inflation"
                value={form.inflationRate * 100}
                onChange={(v) => updateField('inflationRate', (v ?? 0) / 100)}
                decimalPlaces={2}
                allowNegative
                suffix="%"
              />
              <NumericInput
                label="Simulations"
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
                  label="Show in today's value"
                />
              </span>
              <span className="flex-1">
                Show in today&apos;s value (real, inflation-adjusted)
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Applies after the next Run.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={isRunning}>
              {isRunning ? 'Running…' : 'Run simulation'}
            </Button>
            <Button
              variant={savedFlash ? 'primary' : 'outline'}
              onClick={save}
              disabled={savedFlash}
              className={[
                // "Save changes" is the longest label; keep that width fixed
                // so the button doesn't reflow when it shows "Saved!".
                'min-w-[8.25rem] justify-center',
                savedFlash
                  ? '!bg-green-600 hover:!bg-green-600 !border-green-600 !text-white !opacity-100'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {savedFlash
                ? 'Saved!'
                : activeId
                  ? 'Save changes'
                  : 'Save scenario'}
            </Button>
            {activeId && (
              <Button variant="danger" onClick={requestDelete}>
                Delete
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
                label="Median final"
                value={formatCurrency(result.finalDistribution.median)}
              />
              <SummaryStat
                label="10th–90th percentile"
                value={`${formatCurrency(
                  result.percentiles.p10[result.percentiles.p10.length - 1] ?? 0,
                )} – ${formatCurrency(
                  result.percentiles.p90[result.percentiles.p90.length - 1] ?? 0,
                )}`}
                className="lg:col-span-2"
              />
              <SummaryStat
                label="Probability of Depletion"
                value={`${(result.finalDistribution.depletionRate * 100).toFixed(1)}%`}
              />
              <SummaryStat
                label={
                  form.targetValue != null && Number.isFinite(form.targetValue)
                    ? `Probability Above Target (${formatCurrency(form.targetValue)})`
                    : 'Probability Above Target'
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
                  Projected portfolio value{' '}
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                    (in {defaultCurrency},{' '}
                    {result.realValues
                      ? "real / today's value"
                      : 'nominal / future value'}
                    )
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
                        {m === 'chart' ? 'Chart' : 'Table'}
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
                      name="10th percentile"
                    />
                    <Area
                      type="monotone"
                      dataKey="band10to25"
                      stackId="band"
                      stroke="none"
                      fill="#bfdbfe"
                      name="10–25%"
                    />
                    <Area
                      type="monotone"
                      dataKey="band25to75"
                      stackId="band"
                      stroke="none"
                      fill="#60a5fa"
                      name="25–75%"
                    />
                    <Area
                      type="monotone"
                      dataKey="band75to90"
                      stackId="band"
                      stroke="none"
                      fill="#bfdbfe"
                      name="75–90%"
                    />
                    <Line
                      type="monotone"
                      dataKey="p50"
                      stroke="#1d4ed8"
                      strokeWidth={2}
                      dot={false}
                      name="Median"
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
                          stroke="#6b7280"
                          strokeDasharray="4 4"
                          strokeWidth={1.5}
                          label={{
                            value: 'Withdrawal phase →',
                            position: 'insideTopRight',
                            fill: '#6b7280',
                            fontSize: 11,
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
                    Income starts
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="end" income />
                    Income ends
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="start" income={false} />
                    Expense starts
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CashFlowLegendSwatch role="end" income={false} />
                    Expense ends
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="Delete scenario?"
        message={`This will permanently delete "${form.name || 'this scenario'}" and any cash flows attached to it.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}

interface CashFlowEvent {
  role: 'start' | 'end';
  income: boolean;
  name: string;
  amount: number;
  flowType: CashFlowType;
  startYear: number;
  endYear?: number | null;
  inflationAdjust: boolean;
}

function FanChartTooltip({
  active,
  payload,
  label,
  fmt,
  events,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, number> }>;
  label?: string;
  fmt: (v: number) => string;
  events?: CashFlowEvent[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const rows: Array<[string, number]> = [
    ['90th percentile', row.p90],
    ['75th percentile', row.p75],
    ['Median (50th)', row.p50],
    ['25th percentile', row.p25],
    ['10th percentile', row.p10],
  ];
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm max-w-xs">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
      {rows.map(([name, value]) => (
        <p
          key={name}
          className="text-gray-700 dark:text-gray-300 flex justify-between gap-4"
        >
          <span>{name}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {fmt(value)}
          </span>
        </p>
      ))}
      {events && events.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1.5">
          {events.map((e, i) => (
            <div key={i} className="flex items-start gap-2">
              <CashFlowLegendSwatch role={e.role} income={e.income} />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {e.flowType === 'ONE_TIME'
                    ? e.name
                    : `${e.role === 'start' ? 'Starts' : 'Ends'}: ${e.name}`}
                </div>
                <div
                  className={
                    e.income
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                  }
                >
                  {e.income ? '+' : ''}
                  {fmt(e.amount)}
                  {e.flowType === 'RECURRING' ? ' / yr' : ''}
                  {e.inflationAdjust ? ' (inflated)' : ''}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {e.flowType === 'ONE_TIME'
                    ? 'One-time'
                    : `Recurring · year ${e.startYear}${
                        e.endYear ? `–${e.endYear}` : '+'
                      }`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CashFlowMarker({
  cx,
  cy,
  role,
  income,
}: {
  cx: number;
  cy: number;
  role: 'start' | 'end';
  income: boolean;
}) {
  const fill = income ? '#16a34a' : '#dc2626';
  const stroke = '#ffffff';
  // Triangle pointing up = start, pointing down = end. Income green, expense red.
  const size = 7;
  const points =
    role === 'start'
      ? `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`
      : `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
  return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={1.5} />;
}

function CashFlowLegendSwatch({
  role,
  income,
}: {
  role: 'start' | 'end';
  income: boolean;
}) {
  const fill = income ? '#16a34a' : '#dc2626';
  const points =
    role === 'start' ? '7,1 1,11 13,11' : '7,11 1,1 13,1';
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" className="shrink-0">
      <polygon points={points} fill={fill} stroke="#ffffff" strokeWidth={1} />
    </svg>
  );
}

function ResultsTable({
  rows,
  formatCurrency,
}: {
  rows: Array<{
    year: string;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    events: CashFlowEvent[];
  }>;
  formatCurrency: (v: number) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Year</th>
            <th className="px-3 py-2 text-right font-medium">10th</th>
            <th className="px-3 py-2 text-right font-medium">25th</th>
            <th className="px-3 py-2 text-right font-medium">Median</th>
            <th className="px-3 py-2 text-right font-medium">75th</th>
            <th className="px-3 py-2 text-right font-medium">90th</th>
            <th className="px-3 py-2 text-left font-medium">Events</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((r) => (
            <tr key={r.year}>
              <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                {r.year}
              </td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p10)}</td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p25)}</td>
              <td className="px-3 py-1.5 text-right font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(r.p50)}
              </td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p75)}</td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p90)}</td>
              <td className="px-3 py-1.5">
                {r.events.length === 0 ? (
                  <span className="text-gray-400 dark:text-gray-500">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {r.events.map((e, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 ${
                          e.income
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        <CashFlowLegendSwatch role={e.role} income={e.income} />
                        {e.flowType === 'ONE_TIME'
                          ? e.name
                          : `${e.role === 'start' ? 'Starts' : 'Ends'}: ${e.name}`}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingStatsTable({
  data,
  loading,
  formatCurrency,
}: {
  data: AccountHoldingStats[] | null;
  loading: boolean;
  formatCurrency: (v: number) => string;
}) {
  if (loading) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Loading holding stats…
      </p>
    );
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Select one or more accounts to see per-holding historical returns.
      </p>
    );
  }

  const fmtPct = (v: number | null) =>
    v == null ? '—' : `${(v * 100).toFixed(2)}%`;

  return (
    <div className="space-y-3 mb-3">
      {data.map((acct) => (
        <div
          key={acct.accountId}
          className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden"
        >
          <div className="bg-gray-50 dark:bg-gray-900/50 px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {acct.accountName}{' '}
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              ({acct.currencyCode})
            </span>
          </div>
          {acct.holdings.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
              No active holdings.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
                    {/* Name is decorative; hide on small screens so the
                        numeric columns fit on a phone without horizontal
                        scroll. */}
                    <th className="px-3 py-1.5 text-left font-medium hidden sm:table-cell">
                      Name
                    </th>
                    <th className="px-3 py-1.5 text-right font-medium">Value</th>
                    <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">
                      Mean
                    </th>
                    <th className="px-3 py-1.5 text-right font-medium">
                      Volatility
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {acct.holdings.map((h) => (
                    <tr key={`${acct.accountId}-${h.symbol}`}>
                      <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {h.symbol}
                      </td>
                      <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300 truncate max-w-[200px] hidden sm:table-cell">
                        {h.name}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatCurrency(h.marketValue)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {fmtPct(h.meanReturn)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {fmtPct(h.volatility)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg shadow p-4 ${className ?? ''}`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 break-words">
        {value}
      </div>
    </div>
  );
}
