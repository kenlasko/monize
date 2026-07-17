'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import {
  LoanScheduleInput,
  OverpaymentFrequency,
  OverpaymentMode,
  OverpaymentPlan,
} from '@/lib/loan-schedule';
import {
  SolveStatus,
  SolveWindow,
  solveRecurringForInterestSavings,
  solveRecurringForPayoffMonth,
} from '@/lib/loan-overpayment-solver';
import { accountsApi } from '@/lib/accounts';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverpaymentSimulator');

const DEFAULT_MODE: OverpaymentMode = 'SHORTEN_TERM';
const DEFAULT_FREQUENCY: OverpaymentFrequency = 'MONTHLY';

/** How the overpayment is specified. AMOUNT is entered directly; INTEREST and
 *  PAYOFF are goal-seek targets that solve the required amount. */
type SimulationType = 'AMOUNT' | 'INTEREST' | 'PAYOFF';

const FREQUENCIES: OverpaymentFrequency[] = [
  'ONE_OFF',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUALLY',
];

interface SimulatorFormState {
  simType: SimulationType;
  frequency: OverpaymentFrequency;
  /** AMOUNT (or one-off) value entered directly. */
  amount: number | undefined;
  /** INTEREST goal target. */
  goalInterest: number | undefined;
  /** PAYOFF goal target (yyyy-MM-dd). */
  goalDate: string;
  /** The date of a one-off overpayment (required when frequency is ONE_OFF). */
  oneOffDate: string;
  /** Recurring window (ignored for one-off). */
  startDate: string;
  endDate: string;
  mode: OverpaymentMode;
}

const EMPTY_FORM: SimulatorFormState = {
  simType: 'AMOUNT',
  frequency: DEFAULT_FREQUENCY,
  amount: undefined,
  goalInterest: undefined,
  goalDate: '',
  oneOffDate: '',
  startDate: '',
  endDate: '',
  mode: DEFAULT_MODE,
};

interface OverpaymentSimulatorProps {
  accountId: string;
  /** Account currency, for the amount inputs' symbol. */
  currencyCode: string;
  onPlanChange: (plan: OverpaymentPlan | null) => void;
  /** Externally loaded plan (e.g. a saved scenario); applied when version changes */
  loadedPlan?: OverpaymentPlan | null;
  loadedPlanVersion?: number;
  /** The no-overpayment projection base. When supplied, the goal-seek simulation
   *  types are available (solve the amount for a target interest or payoff month). */
  projectionInput?: LoanScheduleInput | null;
  /** Extra header content (e.g. a save-scenario button) */
  headerActions?: React.ReactNode;
  /** Content rendered at the bottom of the card (e.g. saved scenarios) */
  footer?: React.ReactNode;
}

function planToForm(plan: OverpaymentPlan | null): SimulatorFormState {
  if (!plan) return EMPTY_FORM;
  if (plan.recurringExtra) {
    return {
      ...EMPTY_FORM,
      simType: 'AMOUNT',
      frequency: plan.recurringExtra.frequency ?? DEFAULT_FREQUENCY,
      amount: plan.recurringExtra.amount,
      mode: plan.recurringExtra.mode ?? DEFAULT_MODE,
      startDate: plan.recurringExtra.startDate ?? '',
      endDate: plan.recurringExtra.endDate ?? '',
    };
  }
  // A saved one-off is stored as a single lump sum (legacy multi-entry plans
  // collapse to their first entry).
  const first = plan.lumpSums?.[0];
  if (first) {
    return {
      ...EMPTY_FORM,
      simType: 'AMOUNT',
      frequency: 'ONE_OFF',
      amount: first.amount,
      mode: first.mode ?? DEFAULT_MODE,
      oneOffDate: first.date,
    };
  }
  return EMPTY_FORM;
}

/**
 * What-if inputs for the loan detail page. A single "Simulation type" selector
 * chooses how the overpayment is specified -- a direct amount, or a goal (target
 * interest saving / payoff month) that live-solves the required amount -- and a
 * "Frequency" selector chooses its cadence, from a one-off dated payment to a
 * recurring weekly/monthly/quarterly/annual extra. Emits the resulting
 * OverpaymentPlan upward on every change.
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
  const currencySymbol = getCurrencySymbol(currencyCode);

  const [form, setForm] = useState<SimulatorFormState>(EMPTY_FORM);
  const [detectedExtra, setDetectedExtra] = useState<number | null>(null);
  const [goalStatus, setGoalStatus] = useState<SolveStatus | null>(null);

  const isOneOff = form.frequency === 'ONE_OFF';
  const canGoalSeek = !!projectionInput;

  // Apply an externally loaded plan when its version changes (info-from-
  // previous-render pattern; no setState in effect)
  const [appliedPlanVersion, setAppliedPlanVersion] = useState(loadedPlanVersion);
  if (loadedPlanVersion !== appliedPlanVersion) {
    setAppliedPlanVersion(loadedPlanVersion);
    setForm(planToForm(loadedPlan));
    setGoalStatus(null);
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

  // Resolve the plan for a form state, live-solving goal targets. Sets the goal
  // status note and emits the plan. A payoff-month goal forces SHORTEN_TERM
  // (lowering the installment keeps the end date). Solved amounts come back in
  // per-payment terms and are converted to the chosen cadence for the plan; the
  // engine levels them back across payments when projecting.
  const apply = (next: SimulatorFormState) => {
    let status: SolveStatus | null = null;
    let plan: OverpaymentPlan | null = null;

    if (next.frequency === 'ONE_OFF') {
      plan =
        next.amount !== undefined && next.amount > 0 && next.oneOffDate
          ? { lumpSums: [{ date: next.oneOffDate, amount: next.amount, mode: next.mode }] }
          : null;
    } else {
      let amount: number | undefined;
      if (next.simType === 'AMOUNT') {
        amount = next.amount;
      } else if (projectionInput) {
        // The cadence goes to the solver, so it returns the amount per the
        // chosen frequency (e.g. per quarter), not per payment.
        const window: SolveWindow = {
          ...(next.startDate ? { startDate: next.startDate } : {}),
          ...(next.endDate ? { endDate: next.endDate } : {}),
          frequency: next.frequency,
        };
        const solve =
          next.simType === 'INTEREST'
            ? next.goalInterest !== undefined && next.goalInterest > 0
              ? solveRecurringForInterestSavings(projectionInput, next.goalInterest, next.mode, 1, window)
              : null
            : next.goalDate
              ? solveRecurringForPayoffMonth(projectionInput, next.goalDate, 'SHORTEN_TERM', 1, window)
              : null;
        if (solve) {
          status = solve.status;
          if (solve.status === 'ok' && solve.amount != null) {
            amount = solve.amount;
          }
        }
      }
      if (amount !== undefined && amount > 0) {
        plan = {
          recurringExtra: {
            amount,
            frequency: next.frequency,
            mode: next.simType === 'PAYOFF' ? 'SHORTEN_TERM' : next.mode,
            ...(next.startDate ? { startDate: next.startDate } : {}),
            ...(next.endDate ? { endDate: next.endDate } : {}),
          },
        };
      }
    }

    setForm(next);
    setGoalStatus(status);
    onPlanChange(plan);
  };

  const handleSimTypeChange = (simType: SimulationType) =>
    apply({ ...form, simType, mode: simType === 'PAYOFF' ? 'SHORTEN_TERM' : form.mode });

  const handleFrequencyChange = (frequency: OverpaymentFrequency) =>
    // One-off cannot be goal-sought (there is no recurring amount to solve),
    // so it falls back to a directly entered amount.
    apply({ ...form, frequency, simType: frequency === 'ONE_OFF' ? 'AMOUNT' : form.simType });

  const handleAmountChange = (amount: number | undefined) => apply({ ...form, amount });
  const handleInterestChange = (goalInterest: number | undefined) =>
    apply({ ...form, goalInterest });
  const handleDateChange = (goalDate: string) => apply({ ...form, goalDate });
  const handleOneOffDateChange = (oneOffDate: string) => apply({ ...form, oneOffDate });
  const handleStartChange = (startDate: string) => apply({ ...form, startDate });
  const handleEndChange = (endDate: string) => apply({ ...form, endDate });
  const handleModeChange = (mode: OverpaymentMode) => apply({ ...form, mode });

  const reset = () => {
    setGoalStatus(null);
    apply(EMPTY_FORM);
  };

  const hasInput =
    form.amount !== undefined ||
    form.goalInterest !== undefined ||
    form.goalDate !== '' ||
    form.oneOffDate !== '' ||
    form.startDate !== '' ||
    form.endDate !== '';

  const showDetectedHint =
    detectedExtra !== null &&
    form.simType === 'AMOUNT' &&
    !isOneOff &&
    form.amount === undefined;

  const fieldClass = 'min-w-[170px] flex-1';

  // The morphing value field: a money input for a direct amount or an interest
  // target, a date input for a payoff-month target.
  const valueField =
    form.simType === 'PAYOFF' ? (
      <DateInput
        label={t('loanDetail.simulator.goalSeek.targetDateLabel')}
        value={form.goalDate}
        onDateChange={handleDateChange}
      />
    ) : form.simType === 'INTEREST' ? (
      <CurrencyInput
        prefix={currencySymbol}
        allowNegative={false}
        label={t('loanDetail.simulator.goalSeek.targetInterestLabel')}
        value={form.goalInterest}
        onChange={handleInterestChange}
      />
    ) : (
      <CurrencyInput
        prefix={currencySymbol}
        allowNegative={false}
        label={t('loanDetail.simulator.overpaymentAmount')}
        value={form.amount}
        onChange={handleAmountChange}
      />
    );

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

      {showDetectedHint && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-900/20 px-3 py-2 text-sm text-blue-800 dark:text-blue-200">
          <span>
            {t('loanDetail.simulator.detectedExtraHint', {
              amount: formatCurrency(detectedExtra as number),
            })}
          </span>
          <button
            type="button"
            className="font-medium underline hover:no-underline"
            onClick={() => apply({ ...form, simType: 'AMOUNT', amount: detectedExtra ?? undefined })}
          >
            {t('loanDetail.simulator.applyDetected')}
          </button>
        </div>
      )}

      {/* One horizontal row: how to specify the overpayment, its value, its
          cadence, the window (or a one-off date), and the post-overpayment
          effect. */}
      <div className="flex flex-wrap items-end gap-4">
        <div className={fieldClass}>
          <SimulationTypeSelect
            label={t('loanDetail.simulator.simulationTypeLabel')}
            value={form.simType}
            onChange={handleSimTypeChange}
            goalSeekAvailable={canGoalSeek && !isOneOff}
          />
        </div>

        <div className={fieldClass}>{valueField}</div>

        <div className={fieldClass}>
          <FrequencySelect
            label={t('loanDetail.simulator.frequencyLabel')}
            value={form.frequency}
            onChange={handleFrequencyChange}
          />
        </div>

        {isOneOff ? (
          <div className={fieldClass}>
            <DateInput
              label={t('loanDetail.simulator.oneOffDateLabel')}
              value={form.oneOffDate}
              onDateChange={handleOneOffDateChange}
            />
          </div>
        ) : (
          <>
            <div className={fieldClass}>
              <DateInput
                label={t('loanDetail.simulator.recurringStart')}
                value={form.startDate}
                onDateChange={handleStartChange}
              />
            </div>
            <div className={fieldClass}>
              <DateInput
                label={t('loanDetail.simulator.recurringEnd')}
                value={form.endDate}
                onDateChange={handleEndChange}
              />
            </div>
          </>
        )}

        <div className={fieldClass}>
          <ModeSelect
            label={t('loanDetail.simulator.modeLabel')}
            value={form.mode}
            onChange={handleModeChange}
            disabled={form.simType === 'PAYOFF'}
          />
        </div>
      </div>

      {goalStatus === 'unreachable' && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          {t(
            form.simType === 'PAYOFF'
              ? 'loanDetail.simulator.goalSeek.unreachableDate'
              : 'loanDetail.simulator.goalSeek.unreachableInterest',
          )}
        </p>
      )}
      {goalStatus === 'already-met' && (
        <p className="mt-2 text-sm text-green-700 dark:text-green-400">
          {t('loanDetail.simulator.goalSeek.alreadyMet')}
        </p>
      )}

      {footer}
    </div>
  );
}

/** How the overpayment is specified: a direct amount, or a goal-seek target. */
function SimulationTypeSelect({
  label,
  value,
  onChange,
  goalSeekAvailable,
}: {
  label: string;
  value: SimulationType;
  onChange: (value: SimulationType) => void;
  /** Whether the interest/payoff goal options can be chosen (needs a projection
   *  and a recurring cadence). */
  goalSeekAvailable: boolean;
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
        onChange={(e) => onChange(e.target.value as SimulationType)}
        className="block w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
      >
        <option value="AMOUNT">{t('loanDetail.simulator.overpaymentAmount')}</option>
        <option value="INTEREST" disabled={!goalSeekAvailable}>
          {t('loanDetail.simulator.goalSeek.targetInterestLabel')}
        </option>
        <option value="PAYOFF" disabled={!goalSeekAvailable}>
          {t('loanDetail.simulator.goalSeek.targetDateLabel')}
        </option>
      </select>
    </div>
  );
}

/** How often the overpayment recurs (or a single one-off payment). */
function FrequencySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OverpaymentFrequency;
  onChange: (value: OverpaymentFrequency) => void;
}) {
  const t = useTranslations('accounts');
  const optionLabel: Record<OverpaymentFrequency, string> = {
    ONE_OFF: t('loanDetail.simulator.frequencyOneOff'),
    WEEKLY: t('loanDetail.simulator.frequencyWeekly'),
    BIWEEKLY: t('loanDetail.simulator.frequencyBiweekly'),
    MONTHLY: t('loanDetail.simulator.frequencyMonthly'),
    QUARTERLY: t('loanDetail.simulator.frequencyQuarterly'),
    ANNUALLY: t('loanDetail.simulator.frequencyAnnually'),
  };
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {label}
      </label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as OverpaymentFrequency)}
        className="block w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
      >
        {FREQUENCIES.map((frequency) => (
          <option key={frequency} value={frequency}>
            {optionLabel[frequency]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Per-overpayment effect selector: shorten the term or lower the installment. */
function ModeSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: OverpaymentMode;
  onChange: (mode: OverpaymentMode) => void;
  disabled?: boolean;
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
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as OverpaymentMode)}
        className="block w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="SHORTEN_TERM">{t('loanDetail.simulator.modeShortenTerm')}</option>
        <option value="LOWER_INSTALLMENT">{t('loanDetail.simulator.modeLowerInstallment')}</option>
      </select>
    </div>
  );
}
