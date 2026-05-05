'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  monteCarloApi,
  CashFlow,
  MonteCarloScenario,
  MonteCarloScenarioInputs,
  SimulationResult,
} from '@/lib/monte-carlo';
import {
  clearCachedResult,
  getCachedResult,
  setCachedResult,
} from '@/lib/monte-carlo-cache';
import { showErrorToast } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('useMonteCarloScenarios');

const ACTIVE_ID_KEY = 'monize-monte-carlo-active-id';

export interface BrokerageAccount {
  id: string;
  name: string;
  currencyCode: string;
}

export const DEFAULT_INPUTS: MonteCarloScenarioInputs = {
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

export type FormState = Omit<
  MonteCarloScenarioInputs,
  'targetValue' | 'randomSeed' | 'cashFlows'
> & {
  name: string;
  description: string;
  targetValue: number | null;
  randomSeed: string | null;
  cashFlows: CashFlow[];
};

export const EMPTY_FORM: FormState = {
  ...DEFAULT_INPUTS,
  name: '',
  description: '',
  targetValue: null,
  randomSeed: null,
  cashFlows: [],
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

const formStateFromScenario = (s: MonteCarloScenario): FormState => ({
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

// Backend `@IsOptional()` decorators expect omission, not explicit null.
// Build the payload without nullable fields when they have no value.
// Coerce any non-finite numbers (NaN, ±Infinity, null/undefined leaking in
// from API responses) to 0 so we never POST something class-validator will
// reject as "not a number".
export const inputsFromForm = (f: FormState): MonteCarloScenarioInputs => {
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

export function useMonteCarloScenarios() {
  const [accounts, setAccounts] = useState<BrokerageAccount[]>([]);
  const [scenarios, setScenarios] = useState<MonteCarloScenario[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage.getItem(ACTIVE_ID_KEY);
    } catch {
      return null;
    }
  });
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSaveAsDialog, setShowSaveAsDialog] = useState(false);
  const [pendingOverwriteName, setPendingOverwriteName] = useState<string | null>(
    null,
  );

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
  useEffect(() => {
    if (activeId && result) setCachedResult(activeId, result);
  }, [activeId, result]);

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
            setActiveId(match.id);
            setForm(formStateFromScenario(match));
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

  // Auto-populate the starting value when "Use current balance" is on. Refetches
  // when the selected accounts change so the displayed value matches what the
  // simulation will actually use.
  useEffect(() => {
    if (!form.useCurrentBalance || form.accountIds.length === 0) return;
    let cancelled = false;
    const accountIds = form.accountIds;
    monteCarloApi
      .historicalStats(accountIds)
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
          prev.accountIds.every((id) => accountIds.includes(id))
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

  const loadScenario = useCallback((s: MonteCarloScenario) => {
    setActiveId(s.id);
    setForm(formStateFromScenario(s));
    setResult(getCachedResult(s.id));
  }, []);

  const newScenario = useCallback(() => {
    setActiveId(null);
    setForm(EMPTY_FORM);
    setResult(null);
  }, []);

  const addCashFlow = useCallback(() => {
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
  }, []);

  const updateCashFlow = useCallback(
    (idx: number, patch: Partial<CashFlow>) => {
      setForm((prev) => ({
        ...prev,
        cashFlows: prev.cashFlows.map((cf, i) =>
          i === idx ? { ...cf, ...patch } : cf,
        ),
      }));
    },
    [],
  );

  const removeCashFlow = useCallback((idx: number) => {
    setForm((prev) => ({
      ...prev,
      cashFlows: prev.cashFlows.filter((_, i) => i !== idx),
    }));
  }, []);

  // Returns true on success so the caller can react (e.g. collapse inputs).
  const run = useCallback(async (): Promise<boolean> => {
    setIsRunning(true);
    try {
      // Always run with the *current* form values, not the saved scenario.
      // Otherwise editing a loaded scenario and clicking Run would silently
      // re-simulate the saved (stale) values.
      const r = await monteCarloApi.run(inputsFromForm(form));
      setResult(r);
      return true;
    } catch (err) {
      logger.error('Simulation failed:', err);
      showErrorToast(err, 'Simulation failed. Check inputs and try again.');
      return false;
    } finally {
      setIsRunning(false);
    }
  }, [form]);

  const save = useCallback(async () => {
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
  }, [activeId, form]);

  const openSaveAsDialog = useCallback(() => {
    setShowSaveAsDialog(true);
  }, []);

  const performSaveAs = useCallback(
    async (newName: string) => {
      try {
        const inputs = inputsFromForm(form);
        const created = await monteCarloApi.create({
          ...inputs,
          name: newName,
          description: form.description || undefined,
        });
        setScenarios((prev) => [created, ...prev]);
        setActiveId(created.id);
        setForm((prev) => ({ ...prev, name: newName }));
        toast.success('Saved as new scenario.');
      } catch (err) {
        logger.error('Save as failed:', err);
        showErrorToast(err, 'Could not save as new scenario.');
      }
    },
    [form],
  );

  const handleSaveAsSubmit = useCallback(
    async (newName: string) => {
      const activeScenario = scenarios.find((s) => s.id === activeId);
      // Same name as the loaded scenario means the user wants to overwrite —
      // raise a confirm before mutating the existing record.
      if (activeScenario && newName === activeScenario.name) {
        setPendingOverwriteName(newName);
        return;
      }
      setShowSaveAsDialog(false);
      await performSaveAs(newName);
    },
    [activeId, scenarios, performSaveAs],
  );

  const cancelSaveAs = useCallback(() => {
    setShowSaveAsDialog(false);
  }, []);

  const performOverwrite = useCallback(async () => {
    if (!activeId || !pendingOverwriteName) return;
    try {
      const inputs = inputsFromForm(form);
      const updated = await monteCarloApi.update(activeId, {
        ...inputs,
        name: pendingOverwriteName,
        description: form.description || undefined,
      });
      setScenarios((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s)),
      );
      setForm((prev) => ({ ...prev, name: pendingOverwriteName }));
      toast.success('Scenario overwritten.');
    } catch (err) {
      logger.error('Overwrite failed:', err);
      showErrorToast(err, 'Could not overwrite scenario.');
    } finally {
      setPendingOverwriteName(null);
      setShowSaveAsDialog(false);
    }
  }, [activeId, pendingOverwriteName, form]);

  const cancelOverwrite = useCallback(() => {
    setPendingOverwriteName(null);
  }, []);

  const requestDelete = useCallback(() => {
    if (!activeId) return;
    setShowDeleteConfirm(true);
  }, [activeId]);

  const confirmDelete = useCallback(async () => {
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
  }, [activeId, newScenario]);

  const cancelDelete = useCallback(() => {
    setShowDeleteConfirm(false);
  }, []);

  return {
    // data
    accounts,
    scenarios,
    activeId,
    result,
    form,
    // loading flags
    isLoading,
    isRunning,
    savedFlash,
    // dialog state
    showDeleteConfirm,
    showSaveAsDialog,
    pendingOverwriteName,
    // form mutators
    updateField,
    addCashFlow,
    updateCashFlow,
    removeCashFlow,
    // scenario actions
    loadScenario,
    newScenario,
    run,
    save,
    openSaveAsDialog,
    handleSaveAsSubmit,
    cancelSaveAs,
    performOverwrite,
    cancelOverwrite,
    requestDelete,
    confirmDelete,
    cancelDelete,
  };
}
