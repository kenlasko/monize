'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { OverpaymentMode, OverpaymentPlan } from '@/lib/loan-schedule';
import { accountsApi } from '@/lib/accounts';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverpaymentSimulator');

const MAX_LUMP_SUMS = 50;

interface LumpSumFormRow {
  id: number;
  date: string;
  amount: number | undefined;
}

interface SimulatorFormState {
  recurringAmount: number | undefined;
  recurringStart: string;
  recurringEnd: string;
  lumpSums: LumpSumFormRow[];
}

const EMPTY_FORM: SimulatorFormState = {
  recurringAmount: undefined,
  recurringStart: '',
  recurringEnd: '',
  lumpSums: [],
};

interface OverpaymentSimulatorProps {
  accountId: string;
  /** Account currency, for the amount inputs' symbol. */
  currencyCode: string;
  onPlanChange: (plan: OverpaymentPlan | null) => void;
  /** Whether overpayments shorten the term or lower the installment */
  mode: OverpaymentMode;
  onModeChange: (mode: OverpaymentMode) => void;
  /** Externally loaded plan (e.g. a saved scenario); applied when version changes */
  loadedPlan?: OverpaymentPlan | null;
  loadedPlanVersion?: number;
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
    lumpSums: (plan.lumpSums ?? []).map((lumpSum, index) => ({
      id: index,
      date: lumpSum.date,
      amount: lumpSum.amount,
    })),
  };
}

function formToPlan(form: SimulatorFormState): OverpaymentPlan | null {
  const recurringAmount = form.recurringAmount;
  const recurringExtra =
    recurringAmount !== undefined && recurringAmount > 0
      ? {
          amount: recurringAmount,
          ...(form.recurringStart ? { startDate: form.recurringStart } : {}),
          ...(form.recurringEnd ? { endDate: form.recurringEnd } : {}),
        }
      : undefined;

  const lumpSums = form.lumpSums
    .map((row) => ({ date: row.date, amount: row.amount }))
    .filter(
      (lumpSum): lumpSum is { date: string; amount: number } =>
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
  mode,
  onModeChange,
  loadedPlan = null,
  loadedPlanVersion = 0,
  headerActions,
  footer,
}: OverpaymentSimulatorProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const currencySymbol = getCurrencySymbol(currencyCode);

  const [form, setForm] = useState<SimulatorFormState>(EMPTY_FORM);
  const [nextLumpSumId, setNextLumpSumId] = useState(0);
  const [detectedExtra, setDetectedExtra] = useState<number | null>(null);

  // Apply an externally loaded plan when its version changes (info-from-
  // previous-render pattern; no setState in effect)
  const [appliedPlanVersion, setAppliedPlanVersion] = useState(loadedPlanVersion);
  if (loadedPlanVersion !== appliedPlanVersion) {
    setAppliedPlanVersion(loadedPlanVersion);
    const loadedForm = planToForm(loadedPlan);
    setForm(loadedForm);
    setNextLumpSumId(loadedForm.lumpSums.length);
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

  const update = (next: SimulatorFormState) => {
    setForm(next);
    onPlanChange(formToPlan(next));
  };

  const addLumpSum = () => {
    if (form.lumpSums.length >= MAX_LUMP_SUMS) return;
    update({
      ...form,
      lumpSums: [...form.lumpSums, { id: nextLumpSumId, date: '', amount: undefined }],
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

      <div className="mb-4">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
          {t('loanDetail.simulator.modeLabel')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('loanDetail.simulator.modeLabel')}
          className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden"
        >
          {(['SHORTEN_TERM', 'LOWER_INSTALLMENT'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              onClick={() => onModeChange(option)}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === option
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              {option === 'SHORTEN_TERM'
                ? t('loanDetail.simulator.modeShortenTerm')
                : t('loanDetail.simulator.modeLowerInstallment')}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {mode === 'SHORTEN_TERM'
            ? t('loanDetail.simulator.modeShortenTermHint')
            : t('loanDetail.simulator.modeLowerInstallmentHint')}
        </p>
      </div>

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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

      {footer}
    </div>
  );
}
