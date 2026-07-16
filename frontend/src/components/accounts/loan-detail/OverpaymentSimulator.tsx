'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { LoanScheduleInput, OverpaymentMode, OverpaymentPlan } from '@/lib/loan-schedule';
import {
  SolveResult,
  solveRecurringForInterestSavings,
  solveRecurringForPayoffMonth,
} from '@/lib/loan-overpayment-solver';
import { accountsApi } from '@/lib/accounts';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverpaymentSimulator');

const MAX_LUMP_SUMS = 50;

const DEFAULT_MODE: OverpaymentMode = 'SHORTEN_TERM';

interface LumpSumFormRow {
  id: number;
  date: string;
  amount: number | undefined;
  /** Whether this overpayment shortens the term or lowers the installment */
  mode: OverpaymentMode;
}

interface SimulatorFormState {
  recurringAmount: number | undefined;
  recurringStart: string;
  recurringEnd: string;
  recurringMode: OverpaymentMode;
  lumpSums: LumpSumFormRow[];
}

const EMPTY_FORM: SimulatorFormState = {
  recurringAmount: undefined,
  recurringStart: '',
  recurringEnd: '',
  recurringMode: DEFAULT_MODE,
  lumpSums: [],
};

interface OverpaymentSimulatorProps {
  accountId: string;
  /** Account currency, for the amount inputs' symbol. */
  currencyCode: string;
  onPlanChange: (plan: OverpaymentPlan | null) => void;
  /** Externally loaded plan (e.g. a saved scenario); applied when version changes */
  loadedPlan?: OverpaymentPlan | null;
  loadedPlanVersion?: number;
  /** The no-overpayment projection base. When supplied, the goal-seek block is
   *  shown (solve the recurring extra for a target interest or payoff month). */
  projectionInput?: LoanScheduleInput | null;
  /** Extra header content (e.g. a save-scenario button) */
  headerActions?: React.ReactNode;
  /** Content rendered at the bottom of the card (e.g. saved scenarios) */
  footer?: React.ReactNode;
}

function planToForm(plan: OverpaymentPlan | null): SimulatorFormState {
  if (!plan) return EMPTY_FORM;
  return {
    recurringAmount: plan.recurringExtra ? plan.recurringExtra.amount : undefined,
    recurringStart: plan.recurringExtra?.startDate ?? '',
    recurringEnd: plan.recurringExtra?.endDate ?? '',
    recurringMode: plan.recurringExtra?.mode ?? DEFAULT_MODE,
    lumpSums: (plan.lumpSums ?? []).map((lumpSum, index) => ({
      id: index,
      date: lumpSum.date,
      amount: lumpSum.amount,
      mode: lumpSum.mode ?? DEFAULT_MODE,
    })),
  };
}

function formToPlan(form: SimulatorFormState): OverpaymentPlan | null {
  const recurringAmount = form.recurringAmount;
  const recurringExtra =
    recurringAmount !== undefined && recurringAmount > 0
      ? {
          amount: recurringAmount,
          mode: form.recurringMode,
          ...(form.recurringStart ? { startDate: form.recurringStart } : {}),
          ...(form.recurringEnd ? { endDate: form.recurringEnd } : {}),
        }
      : undefined;

  const lumpSums = form.lumpSums
    .map((row) => ({ date: row.date, amount: row.amount, mode: row.mode }))
    .filter(
      (lumpSum): lumpSum is { date: string; amount: number; mode: OverpaymentMode } =>
        !!lumpSum.date && lumpSum.amount !== undefined && lumpSum.amount > 0,
    );

  if (!recurringExtra && lumpSums.length === 0) return null;
  return {
    ...(recurringExtra ? { recurringExtra } : {}),
    ...(lumpSums.length > 0 ? { lumpSums } : {}),
  };
}

/**
 * What-if inputs for the loan detail page: a recurring extra payment with an
 * optional date window plus one-off lump sums. Emits the resulting
 * OverpaymentPlan upward on every change; the page recomputes the scenario
 * schedule synchronously.
 */
export function OverpaymentSimulator({
  accountId,
  currencyCode,
  onPlanChange,
  loadedPlan = null,
  loadedPlanVersion = 0,
  headerActions,
  footer,
  projectionInput = null,
}: OverpaymentSimulatorProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const currencySymbol = getCurrencySymbol(currencyCode);

  const [form, setForm] = useState<SimulatorFormState>(EMPTY_FORM);
  const [nextLumpSumId, setNextLumpSumId] = useState(0);
  const [detectedExtra, setDetectedExtra] = useState<number | null>(null);

  // Goal-seek: solve the recurring extra for a target interest saving or payoff
  // month. Results are computed on demand (each solve runs the schedule engine).
  const [goalInterest, setGoalInterest] = useState<number | undefined>(undefined);
  const [goalDate, setGoalDate] = useState('');
  const [interestSolve, setInterestSolve] = useState<SolveResult | null>(null);
  const [dateSolve, setDateSolve] = useState<SolveResult | null>(null);

  // Apply an externally loaded plan when its version changes (info-from-
  // previous-render pattern; no setState in effect)
  const [appliedPlanVersion, setAppliedPlanVersion] = useState(loadedPlanVersion);
  if (loadedPlanVersion !== appliedPlanVersion) {
    setAppliedPlanVersion(loadedPlanVersion);
    const loadedForm = planToForm(loadedPlan);
    setForm(loadedForm);
    setNextLumpSumId(loadedForm.lumpSums.length);
    // A loaded scenario replaces the form, so any goal-seek line no longer
    // describes the schedule on screen.
    setInterestSolve(null);
    setDateSolve(null);
  }

  // Suggest the historically detected extra principal as a starting point
  useEffect(() => {
    let cancelled = false;
    accountsApi
      .detectLoanPayments(accountId)
      .then((detected) => {
        if (!cancelled && detected && detected.averageExtraPrincipal > 0) {
          setDetectedExtra(detected.averageExtraPrincipal);
        }
      })
      .catch((error) => {
        // The hint is best-effort; the simulator works without it
        logger.debug('Loan payment detection unavailable:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Every form change invalidates a previously solved goal-seek line -- the
  // required-extra text would describe a schedule that is no longer on screen.
  // The solve handlers re-set their result right after calling update(), so a
  // fresh solve survives its own apply.
  const update = (next: SimulatorFormState) => {
    setForm(next);
    setInterestSolve(null);
    setDateSolve(null);
    onPlanChange(formToPlan(next));
  };

  const addLumpSum = () => {
    if (form.lumpSums.length >= MAX_LUMP_SUMS) return;
    update({
      ...form,
      lumpSums: [
        ...form.lumpSums,
        { id: nextLumpSumId, date: '', amount: undefined, mode: DEFAULT_MODE },
      ],
    });
    setNextLumpSumId(nextLumpSumId + 1);
  };

  const updateLumpSum = (id: number, patch: Partial<LumpSumFormRow>) => {
    update({
      ...form,
      lumpSums: form.lumpSums.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  };

  const removeLumpSum = (id: number) => {
    update({ ...form, lumpSums: form.lumpSums.filter((row) => row.id !== id) });
  };

  const reset = () => {
    update(EMPTY_FORM);
  };

  const runInterestSolve = () => {
    if (!projectionInput || goalInterest === undefined || goalInterest < 0) return;
    const solve = solveRecurringForInterestSavings(projectionInput, goalInterest);
    if (solve.status === 'ok' && solve.amount != null) applySolvedAmount(solve.amount);
    // After applySolvedAmount: update() cleared both solve lines, so setting
    // this one leaves exactly the fresh result visible.
    setInterestSolve(solve);
  };

  const runDateSolve = () => {
    if (!projectionInput || !goalDate) return;
    const solve = solveRecurringForPayoffMonth(projectionInput, goalDate);
    if (solve.status === 'ok' && solve.amount != null) applySolvedAmount(solve.amount);
    setDateSolve(solve);
  };

  // A solved recurring extra is applied to the simulator immediately -- like
  // typing into "Extra per payment" -- so the schedule, chart and savings cards
  // recompute without a separate Apply step. SHORTEN_TERM with no date window
  // matches how the solver modelled it.
  const applySolvedAmount = (amount: number) => {
    update({
      ...form,
      recurringAmount: amount,
      recurringMode: 'SHORTEN_TERM',
      recurringStart: '',
      recurringEnd: '',
    });
  };

  const hasInput =
    form.recurringAmount !== undefined ||
    form.recurringStart !== '' ||
    form.recurringEnd !== '' ||
    form.lumpSums.length > 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('loanDetail.simulator.title')}
        </h3>
        <div className="flex items-center gap-2">
          {hasInput && (
            <Button variant="ghost" size="sm" onClick={reset}>
              {t('loanDetail.simulator.reset')}
            </Button>
          )}
          {headerActions}
        </div>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('loanDetail.simulator.description')}
      </p>

      {detectedExtra !== null && form.recurringAmount === undefined && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-blue-800 dark:text-blue-200">
          <span>
            {t('loanDetail.simulator.detectedExtraHint', {
              amount: formatCurrency(detectedExtra),
            })}
          </span>
          <button
            type="button"
            className="font-medium underline hover:no-underline"
            onClick={() => update({ ...form, recurringAmount: detectedExtra })}
          >
            {t('loanDetail.simulator.applyDetected')}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <CurrencyInput
          prefix={currencySymbol}
          allowNegative={false}
          label={t('loanDetail.simulator.recurringAmount')}
          value={form.recurringAmount}
          onChange={(value) => update({ ...form, recurringAmount: value })}
        />
        <DateInput
          label={t('loanDetail.simulator.recurringStart')}
          value={form.recurringStart}
          onDateChange={(date) => update({ ...form, recurringStart: date })}
        />
        <DateInput
          label={t('loanDetail.simulator.recurringEnd')}
          value={form.recurringEnd}
          onDateChange={(date) => update({ ...form, recurringEnd: date })}
        />
        <ModeSelect
          label={t('loanDetail.simulator.modeLabel')}
          value={form.recurringMode}
          onChange={(recurringMode) => update({ ...form, recurringMode })}
        />
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('loanDetail.simulator.lumpSums')}
          </h4>
          <Button
            variant="outline"
            size="sm"
            onClick={addLumpSum}
            disabled={form.lumpSums.length >= MAX_LUMP_SUMS}
          >
            {t('loanDetail.simulator.addLumpSum')}
          </Button>
        </div>

        {form.lumpSums.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.simulator.noLumpSums')}
          </p>
        ) : (
          <div className="space-y-2">
            {form.lumpSums.map((row) => (
              <div key={row.id} className="flex flex-wrap items-end gap-3">
                <div className="w-full sm:w-52">
                  <DateInput
                    label={t('loanDetail.simulator.lumpSumDate')}
                    value={row.date}
                    onDateChange={(date) => updateLumpSum(row.id, { date })}
                  />
                </div>
                <div className="w-full sm:w-44">
                  <CurrencyInput
                    prefix={currencySymbol}
                    allowNegative={false}
                    label={t('loanDetail.simulator.lumpSumAmount')}
                    value={row.amount}
                    onChange={(value) => updateLumpSum(row.id, { amount: value })}
                  />
                </div>
                <div className="w-full sm:w-52">
                  <ModeSelect
                    label={t('loanDetail.simulator.modeLabel')}
                    value={row.mode}
                    onChange={(m) => updateLumpSum(row.id, { mode: m })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLumpSum(row.id)}
                  aria-label={t('loanDetail.simulator.removeLumpSum')}
                >
                  {t('loanDetail.simulator.removeLumpSum')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {projectionInput && (
        <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            {t('loanDetail.simulator.goalSeek.title')}
          </h4>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            {t('loanDetail.simulator.goalSeek.description')}
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Target interest savings -> required recurring extra */}
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[10rem]">
                  <CurrencyInput
                    prefix={currencySymbol}
                    allowNegative={false}
                    label={t('loanDetail.simulator.goalSeek.targetInterestLabel')}
                    value={goalInterest}
                    onChange={setGoalInterest}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runInterestSolve}
                  disabled={goalInterest === undefined}
                >
                  {t('loanDetail.simulator.goalSeek.compute')}
                </Button>
              </div>
              <SolveResultLine
                solve={interestSolve}
                formatCurrency={formatCurrency}
                formatDate={formatDate}
                currencyCode={currencyCode}
                unreachableKey="loanDetail.simulator.goalSeek.unreachableInterest"
              />
            </div>

            {/* Target payoff month -> required recurring extra */}
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[10rem]">
                  <DateInput
                    label={t('loanDetail.simulator.goalSeek.targetDateLabel')}
                    value={goalDate}
                    onDateChange={setGoalDate}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runDateSolve}
                  disabled={!goalDate}
                >
                  {t('loanDetail.simulator.goalSeek.compute')}
                </Button>
              </div>
              <SolveResultLine
                solve={dateSolve}
                formatCurrency={formatCurrency}
                formatDate={formatDate}
                currencyCode={currencyCode}
                unreachableKey="loanDetail.simulator.goalSeek.unreachableDate"
              />
            </div>
          </div>
        </div>
      )}

      {footer}
    </div>
  );
}

/** Renders a goal-seek outcome: the required recurring extra with its effect
 *  (already applied to the simulator), or an already-met / unreachable note. */
function SolveResultLine({
  solve,
  formatCurrency,
  formatDate,
  currencyCode,
  unreachableKey,
}: {
  solve: SolveResult | null;
  formatCurrency: (amount: number, currency?: string) => string;
  formatDate: (date: string) => string;
  currencyCode: string;
  unreachableKey: string;
}) {
  const t = useTranslations('accounts');
  if (!solve) return null;

  if (solve.status === 'unreachable') {
    return <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{t(unreachableKey)}</p>;
  }
  if (solve.status === 'already-met') {
    return (
      <p className="mt-2 text-sm text-green-700 dark:text-green-400">
        {t('loanDetail.simulator.goalSeek.alreadyMet')}
      </p>
    );
  }
  const result = solve.result!;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="font-medium text-gray-900 dark:text-gray-100">
        {t('loanDetail.simulator.goalSeek.required', {
          amount: formatCurrency(solve.amount ?? 0, currencyCode),
        })}
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        {t('loanDetail.simulator.goalSeek.effect', {
          interest: formatCurrency(solve.interestSaved ?? 0, currencyCode),
          date: result.payoffDate ? formatDate(result.payoffDate) : '—',
        })}
      </span>
    </div>
  );
}

/** Per-overpayment effect selector: shorten the term or lower the installment. */
function ModeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OverpaymentMode;
  onChange: (mode: OverpaymentMode) => void;
}) {
  const t = useTranslations('accounts');
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
      </label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as OverpaymentMode)}
        className="block w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
      >
        <option value="SHORTEN_TERM">{t('loanDetail.simulator.modeShortenTerm')}</option>
        <option value="LOWER_INSTALLMENT">{t('loanDetail.simulator.modeLowerInstallment')}</option>
      </select>
    </div>
  );
}
