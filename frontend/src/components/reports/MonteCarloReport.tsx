'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
} from 'recharts';
import {
  monteCarloApi,
  MonteCarloScenario,
  MonteCarloScenarioInputs,
  SimulationResult,
  AccountHoldingStats,
} from '@/lib/monte-carlo';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getCurrencySymbol } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
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

type FormState = Omit<MonteCarloScenarioInputs, 'targetValue' | 'randomSeed'> & {
  name: string;
  description: string;
  targetValue: number | null;
  randomSeed: string | null;
};

const EMPTY_FORM: FormState = {
  ...DEFAULT_INPUTS,
  name: '',
  description: '',
  targetValue: null,
  randomSeed: null,
};

export function MonteCarloReport() {
  const { formatCurrency, formatCurrencyLabel, defaultCurrency } = useNumberFormat();
  const currencySymbol = useMemo(() => getCurrencySymbol(defaultCurrency), [defaultCurrency]);
  const [accounts, setAccounts] = useState<BrokerageAccount[]>([]);
  const [scenarios, setScenarios] = useState<MonteCarloScenario[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [holdingStats, setHoldingStats] = useState<AccountHoldingStats[] | null>(null);
  const [holdingStatsLoading, setHoldingStatsLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extractError = (err: unknown, fallback: string): string => {
    const e = err as { response?: { data?: { message?: string | string[] } } };
    const msg = e?.response?.data?.message;
    if (Array.isArray(msg)) return msg.join('; ');
    if (typeof msg === 'string') return msg;
    return fallback;
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [accs, scns] = await Promise.all([
          monteCarloApi.brokerageAccounts(),
          monteCarloApi.list(),
        ]);
        setAccounts(accs);
        setScenarios(scns);
      } catch (err) {
        logger.error('Failed to load Monte Carlo data:', err);
        setError('Failed to load. Please refresh.');
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
    });
    setResult(null);
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
    return {
      ...base,
      ...(targetValue != null ? { targetValue } : {}),
      ...(f.randomSeed ? { randomSeed: f.randomSeed } : {}),
    } as MonteCarloScenarioInputs;
  };

  const run = async () => {
    setError(null);
    setIsRunning(true);
    try {
      const r = activeId
        ? await monteCarloApi.runSaved(activeId)
        : await monteCarloApi.run(inputsFromForm(form));
      setResult(r);
    } catch (err) {
      logger.error('Simulation failed:', err);
      setError(extractError(err, 'Simulation failed. Check inputs and try again.'));
    } finally {
      setIsRunning(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!form.name.trim()) {
      setError('Please enter a scenario name to save.');
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
      } else {
        const created = await monteCarloApi.create(payload);
        setScenarios((prev) => [created, ...prev]);
        setActiveId(created.id);
      }
    } catch (err) {
      logger.error('Save failed:', err);
      setError(extractError(err, 'Could not save scenario.'));
    }
  };

  const removeActive = async () => {
    if (!activeId) return;
    if (!window.confirm('Delete this scenario?')) return;
    try {
      await monteCarloApi.remove(activeId);
      setScenarios((prev) => prev.filter((s) => s.id !== activeId));
      newScenario();
    } catch (err) {
      logger.error('Delete failed:', err);
      setError(extractError(err, 'Could not delete scenario.'));
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
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
            <div className="flex items-end pb-2">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={form.useCurrentBalance}
                  onChange={(e) =>
                    updateField('useCurrentBalance', e.target.checked)
                  }
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
                label="Target portfolio"
                value={form.targetValue ?? undefined}
                onChange={(v) => updateField('targetValue', v ?? null)}
                allowNegative={false}
                prefix={currencySymbol}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Annual withdrawal is in today&apos;s dollars and is grown by the
              inflation rate each year so purchasing power stays constant
              throughout the withdrawal phase.
            </p>
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
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 mt-3">
              <input
                type="checkbox"
                checked={form.showRealValues}
                onChange={(e) => updateField('showRealValues', e.target.checked)}
              />
              Show in today&apos;s dollars (real, inflation-adjusted)
            </label>
          </fieldset>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={run} disabled={isRunning}>
              {isRunning ? 'Running…' : 'Run simulation'}
            </Button>
            <Button variant="outline" onClick={save}>
              {activeId ? 'Save changes' : 'Save scenario'}
            </Button>
            {activeId && (
              <Button variant="danger" onClick={removeActive}>
                Delete
              </Button>
            )}
          </div>
        </div>

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
              />
              <SummaryStat
                label="Probability of depletion"
                value={`${(result.finalDistribution.depletionRate * 100).toFixed(1)}%`}
              />
              <SummaryStat
                label="Probability above target"
                value={
                  result.successRate == null
                    ? '—'
                    : `${(result.successRate * 100).toFixed(1)}%`
                }
              />
            </div>

            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
              <h3 className="font-semibold mb-2 text-gray-900 dark:text-gray-100">
                Projected portfolio value{' '}
                <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                  (in {defaultCurrency},{' '}
                  {result.realValues ? "today's dollars" : 'nominal'})
                </span>
              </h3>
              <div className="h-80 w-full">
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
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function FanChartTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, number> }>;
  label?: string;
  fmt: (v: number) => string;
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
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm">
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
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
                  <th className="px-3 py-1.5 text-left font-medium">Name</th>
                  <th className="px-3 py-1.5 text-right font-medium">Value</th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    Mean return
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    Volatility
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium">Years</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {acct.holdings.map((h) => (
                  <tr key={`${acct.accountId}-${h.symbol}`}>
                    <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                      {h.symbol}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300 truncate max-w-[200px]">
                      {h.name}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-700 dark:text-gray-300">
                      {formatCurrency(h.marketValue)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {fmtPct(h.meanReturn)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-900 dark:text-gray-100">
                      {fmtPct(h.volatility)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-500 dark:text-gray-400">
                      {h.yearsObserved}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
        {value}
      </div>
    </div>
  );
}
