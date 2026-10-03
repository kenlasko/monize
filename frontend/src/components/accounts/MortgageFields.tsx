'use client';

import { useState, useEffect, useCallback, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { NumericInput } from '@/components/ui/NumericInput';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import {
  Account,
  MortgageAmortizationPreview,
  MortgagePaymentFrequency,
  InterestBookingMode,
  MortgageType,
  MORTGAGE_TYPES,
} from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { PREPAYMENT_MODES, storesConstantPayment } from '@/lib/mortgage-type';
import { OverpaymentRecognitionFields } from './OverpaymentRecognitionFields';
import { MortgageTypeDetector } from './MortgageTypeDetector';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

const logger = createLogger('MortgageFields');

/** The cadence each accelerated one pays on. */
const ACCELERATED_BASE_CADENCE: Partial<Record<string, MortgagePaymentFrequency>> = {
  ACCELERATED_BIWEEKLY: 'BIWEEKLY',
  ACCELERATED_WEEKLY: 'WEEKLY',
};

interface MortgageFieldsProps {
  watchedCurrency: string;
  openingBalance: number | undefined;
  interestRate: number | undefined;
  paymentStartDate: string | undefined;
  mortgageType: MortgageType | undefined;
  onViewLoanDetails?: () => void;
  termMonths: number | undefined;
  amortizationMonths: number | undefined;
  mortgagePaymentFrequency: MortgagePaymentFrequency | undefined;
  setValue: UseFormSetValue<any>;
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
  accounts: Account[];
  categories: Category[];
  formatCurrency: (amount: number, currency?: string) => string;
  isEditing: boolean;
  selectedInterestCategoryId: string;
  handleInterestCategoryChange: (categoryId: string) => void;
  interestBookingMode: InterestBookingMode;
  handleInterestBookingModeChange: (mode: InterestBookingMode) => void;
  selectedOverpaymentCategoryId: string;
  handleOverpaymentCategoryChange: (categoryId: string) => void;
  selectedOverpaymentPayeeId: string;
  handleOverpaymentPayeeChange: (payeeId: string) => void;
}

export function MortgageFields({
  watchedCurrency,
  openingBalance,
  interestRate,
  paymentStartDate,
  mortgageType,
  onViewLoanDetails,
  termMonths,
  amortizationMonths,
  mortgagePaymentFrequency,
  setValue,
  register,
  errors,
  accounts,
  categories,
  formatCurrency,
  isEditing,
  selectedInterestCategoryId,
  handleInterestCategoryChange,
  interestBookingMode,
  handleInterestBookingModeChange,
  selectedOverpaymentCategoryId,
  handleOverpaymentCategoryChange,
  selectedOverpaymentPayeeId,
  handleOverpaymentPayeeChange,
}: MortgageFieldsProps) {
  const t = useTranslations('accounts');
  const { formatDate } = useDateFormat();
  // Money arrives as a prop; the preview's rate does not, and it is just as
  // user-facing -- so it takes the same number locale rather than `toFixed`.
  const { formatPercent } = useNumberFormat();

  // A LINEAR or INTEREST_ONLY mortgage has no constant payment: its preview
  // shows the first installment, and the accelerated cadences -- a fraction of
  // an annuity's monthly installment -- mean nothing for it, so they are not
  // offered (docs/specs/mortgage-types.md, section 5.1; the server refuses
  // them too).
  const hasConstantPayment = !mortgageType || storesConstantPayment(mortgageType);
  const mortgagePaymentFrequencyOptions = [
    { value: 'MONTHLY', label: t('mortgageFields.frequencyOptions.monthly') },
    { value: 'SEMI_MONTHLY', label: t('mortgageFields.frequencyOptions.semiMonthly') },
    { value: 'BIWEEKLY', label: t('mortgageFields.frequencyOptions.biweekly') },
    { value: 'ACCELERATED_BIWEEKLY', label: t('mortgageFields.frequencyOptions.acceleratedBiweekly') },
    { value: 'WEEKLY', label: t('mortgageFields.frequencyOptions.weekly') },
    { value: 'ACCELERATED_WEEKLY', label: t('mortgageFields.frequencyOptions.acceleratedWeekly') },
  ].filter(
    (option) => hasConstantPayment || !ACCELERATED_BASE_CADENCE[option.value],
  );

  // Choosing a type without a constant payment while an accelerated cadence is
  // selected moves the cadence to the one it accelerates, in the same event,
  // so the form never holds a value its list no longer offers.
  const mortgageTypeField = register('mortgageType');
  const moveCadenceFor = (next: MortgageType | undefined) => {
    const base = mortgagePaymentFrequency
      ? ACCELERATED_BASE_CADENCE[mortgagePaymentFrequency]
      : undefined;
    if (next && !storesConstantPayment(next) && base) {
      setValue('mortgagePaymentFrequency', base, { shouldDirty: true, shouldValidate: true });
    }
  };
  const handleMortgageTypeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    mortgageTypeField.onChange(event);
    moveCadenceFor(MORTGAGE_TYPES.find((type) => type === event.target.value));
  };
  // A suggestion the person confirmed sets the select as choosing it would.
  const applyDetectedType = (type: MortgageType) => {
    setValue('mortgageType', type, { shouldDirty: true, shouldValidate: true });
    moveCadenceFor(type);
  };
  const [mortgagePreview, setMortgagePreview] = useState<MortgageAmortizationPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Local state for the years+months pairs the form stores as a month total
  const [termYears, setTermYears] = useState<number | undefined>(() =>
    termMonths != null && termMonths > 0 ? Math.floor(termMonths / 12) : undefined,
  );
  const [termRemainder, setTermRemainder] = useState<number | undefined>(() =>
    termMonths != null && termMonths > 0 ? termMonths % 12 : undefined,
  );
  const [amortYears, setAmortYears] = useState<number | undefined>(() =>
    amortizationMonths != null && amortizationMonths > 0
      ? Math.floor(amortizationMonths / 12)
      : undefined,
  );
  const [amortRemainder, setAmortRemainder] = useState<number | undefined>(() =>
    amortizationMonths != null && amortizationMonths > 0 ? amortizationMonths % 12 : undefined,
  );

  // Sync local state when termMonths/amortizationMonths change externally (e.g. form reset)
  useEffect(() => {
    if (termMonths != null && termMonths > 0) {
      setTermYears(Math.floor(termMonths / 12));
      setTermRemainder(termMonths % 12);
    }
  }, [termMonths]);

  useEffect(() => {
    if (amortizationMonths != null && amortizationMonths > 0) {
      setAmortYears(Math.floor(amortizationMonths / 12));
      setAmortRemainder(amortizationMonths % 12);
    }
  }, [amortizationMonths]);

  const updateTermMonths = (years: number | undefined, months: number | undefined) => {
    const total = (years ?? 0) * 12 + (months ?? 0);
    setValue('termMonths', total, { shouldValidate: true, shouldDirty: true });
  };

  const updateAmortizationMonths = (years: number | undefined, months: number | undefined) => {
    const total = (years ?? 0) * 12 + (months ?? 0);
    setValue('amortizationMonths', total > 0 ? total : undefined, { shouldValidate: true, shouldDirty: true });
  };

  // Each pair is a years/months split of one month total, so an out-of-range
  // entry is discarded rather than clamped: the months half only carries the
  // remainder (0-11) and rolling 12 into the years half silently is worse than
  // ignoring the keystroke. NumericInput's own `max` trims on blur; this
  // rejects the value while it is being typed.
  const inRange = (value: number | undefined, max: number) =>
    value === undefined || (value >= 0 && value <= max);

  const handleTermYearsChange = (value: number | undefined) => {
    if (!inRange(value, 99)) return;
    setTermYears(value);
    updateTermMonths(value, termRemainder);
  };

  const handleTermMonthsChange = (value: number | undefined) => {
    if (!inRange(value, 11)) return;
    setTermRemainder(value);
    updateTermMonths(termYears, value);
  };

  const handleAmortYearsChange = (value: number | undefined) => {
    if (!inRange(value, 99)) return;
    setAmortYears(value);
    updateAmortizationMonths(value, amortRemainder);
  };

  const handleAmortMonthsChange = (value: number | undefined) => {
    if (!inRange(value, 11)) return;
    setAmortRemainder(value);
    updateAmortizationMonths(amortYears, value);
  };

  const calculateMortgagePreview = useCallback(async () => {
    // `interestRate == null`, not `!interestRate`: 0% is a real mortgage rate
    // (the DTO validates `@Min(0)`, and an interest-free loan or a promotional
    // 0% deal is an ordinary thing to record), so a falsy check read a KNOWN
    // zero as "not set yet" and showed no preview at all. The other three are
    // falsy-checked deliberately: a zero principal, a zero-month amortization
    // or an empty date genuinely mean "not filled in".
    if (
      isEditing ||
      !mortgageType ||
      !openingBalance ||
      interestRate == null ||
      !amortizationMonths ||
      !mortgagePaymentFrequency ||
      !paymentStartDate
    ) {
      setMortgagePreview(null);
      return;
    }

    setIsLoadingPreview(true);
    try {
      const preview = await accountsApi.previewMortgageAmortization({
        mortgageAmount: openingBalance,
        interestRate,
        amortizationMonths,
        paymentFrequency: mortgagePaymentFrequency,
        paymentStartDate,
        // The type decides the convention.
        mortgageType,
      });
      setMortgagePreview(preview);
    } catch (error) {
      logger.error('Failed to calculate mortgage preview:', error);
      setMortgagePreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [isEditing, openingBalance, interestRate, amortizationMonths, mortgagePaymentFrequency, paymentStartDate, mortgageType]);

  useEffect(() => {
    const timer = setTimeout(() => {
      calculateMortgagePreview();
    }, 500);
    return () => clearTimeout(timer);
  }, [calculateMortgagePreview]);


  return (
    <div className="space-y-4 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('mortgageFields.title')}
      </h3>

      {/* One select for the mortgage's convention and method; the help line
          under it says how to recognise the selected type from a statement. */}
      <div>
        <Select
          id="mortgageType"
          label={t('mortgageFields.type.label')}
          options={MORTGAGE_TYPES.map((type) => ({
            value: type,
            label: t(`mortgageFields.type.${type}`),
          }))}
          error={errors.mortgageType?.message as string | undefined}
          {...mortgageTypeField}
          onChange={handleMortgageTypeChange}
        />
        {mortgageType && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(`mortgageFields.type.help.${mortgageType}`)}
          </p>
        )}
        {/* Creating only: an existing mortgage with history detects its type
            from its own installments in Loan Details. */}
        {!isEditing && (
          <MortgageTypeDetector
            interestRate={interestRate}
            paymentFrequency={mortgagePaymentFrequency}
            currencyCode={watchedCurrency}
            onUse={applyDetectedType}
          />
        )}
        {isEditing && onViewLoanDetails && (
          <p className="text-xs mt-1">
            {t.rich('mortgageFields.rateChangesLoanDetailsLink', {
              link: (chunks) => (
                <button
                  type="button"
                  onClick={onViewLoanDetails}
                  className="font-medium underline text-purple-700 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-200"
                >
                  {chunks}
                </button>
              ),
            })}
          </p>
        )}
      </div>

      {/* What an extra repayment does: a LINEAR mortgage's own setting
          (spec decision 4). Every other type stores none. */}
      {mortgageType === 'LINEAR' && (
        <div>
          <Select
            id="prepaymentMode"
            label={t('mortgageFields.prepaymentMode.label')}
            options={PREPAYMENT_MODES.map((mode) => ({
              value: mode,
              label: t(`mortgageFields.prepaymentMode.${mode}`),
            }))}
            error={errors.prepaymentMode?.message as string | undefined}
            {...register('prepaymentMode')}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('mortgageFields.prepaymentMode.help')}
          </p>
        </div>
      )}

      {/* Hidden inputs for form registration */}
      <input type="hidden" {...register('termMonths', { valueAsNumber: true })} />
      <input type="hidden" {...register('amortizationMonths', { valueAsNumber: true })} />

      {/* Term Length - years + months inputs. The rate-fixed period (a
          Canadian term, a UK fixed deal, a Dutch rentevaste periode), shown for
          every type; its end drives the renewal reminder. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('mortgageFields.termLength')}
        </label>
        <div className="grid grid-cols-2 gap-4">
          <NumericInput
            id="mortgage-term-years"
            label={t('mortgageFields.years')}
            decimalPlaces={0}
            min={0}
            max={99}
            value={termYears}
            onChange={handleTermYearsChange}
            error={errors.termMonths?.message as string | undefined}
          />
          <NumericInput
            id="mortgage-term-months"
            label={t('mortgageFields.months')}
            decimalPlaces={0}
            min={0}
            max={11}
            value={termRemainder}
            onChange={handleTermMonthsChange}
          />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('mortgageFields.termLengthHelp')}
        </p>
      </div>

      {/* Amortization Period - years + months inputs */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('mortgageFields.amortizationPeriod')}
        </label>
        <div className="grid grid-cols-2 gap-4">
          <NumericInput
            id="mortgage-amortization-years"
            label={t('mortgageFields.years')}
            decimalPlaces={0}
            min={0}
            max={99}
            value={amortYears}
            onChange={handleAmortYearsChange}
            error={errors.amortizationMonths?.message as string | undefined}
          />
          <NumericInput
            id="mortgage-amortization-months"
            label={t('mortgageFields.months')}
            decimalPlaces={0}
            min={0}
            max={11}
            value={amortRemainder}
            onChange={handleAmortMonthsChange}
          />
        </div>
      </div>

      {!isEditing && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Select
              label={t('mortgageFields.paymentFrequency')}
              options={[
                { value: '', label: t('mortgageFields.selectFrequency') },
                ...mortgagePaymentFrequencyOptions,
              ]}
              error={errors.mortgagePaymentFrequency?.message as string | undefined}
              {...register('mortgagePaymentFrequency')}
            />

            <DateInput
              label={t('mortgageFields.firstPaymentDate')}
              error={errors.paymentStartDate?.message as string | undefined}
              onDateChange={(date) => setValue('paymentStartDate', date, { shouldDirty: true, shouldValidate: true })}
              {...register('paymentStartDate')}
            />
          </div>

          <Select
            label={t('mortgageFields.paymentFromAccount')}
            options={[
              { value: '', label: t('mortgageFields.selectAccount') },
              ...buildAccountDropdownOptions(
                accounts,
                () => true,
                (a) => `${a.name} (${a.currencyCode})`,
              ),
            ]}
            error={errors.sourceAccountId?.message as string | undefined}
            {...register('sourceAccountId')}
          />

          {/* Mortgage Amortization Preview */}
          {mortgagePreview && (
            <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                {t('mortgageFields.previewTitle')}
              </h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-gray-500 dark:text-gray-400">
                    {hasConstantPayment
                      ? t('mortgageFields.previewPaymentAmount')
                      : t('mortgageFields.previewFirstInstallment')}
                  </span>{' '}
                  <span className="font-medium">{formatCurrency(mortgagePreview.paymentAmount, watchedCurrency)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewEffectiveRate')}</span>{' '}
                  <span className="font-medium">{formatPercent(mortgagePreview.effectiveAnnualRate, 2)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewFirstPrincipal')}</span>{' '}
                  <span className="font-medium">{formatCurrency(mortgagePreview.principalPayment, watchedCurrency)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewFirstInterest')}</span>{' '}
                  <span className="font-medium">{formatCurrency(mortgagePreview.interestPayment, watchedCurrency)}</span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewTotalPayments')}</span>{' '}
                  <span className="font-medium">
                    {mortgagePreview.totalPayments > 0 ? mortgagePreview.totalPayments : t('mortgageFields.previewNA')}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewTotalInterest')}</span>{' '}
                  <span className="font-medium">
                    {/* -1 is the "could not be worked out" sentinel; 0 is a
                        known zero (a 0% mortgage costs no interest), and
                        collapsing the two reported it as N/A. Matches the
                        `>= 0` test on the residual payoff below. */}
                    {mortgagePreview.totalInterest >= 0
                      ? formatCurrency(mortgagePreview.totalInterest, watchedCurrency)
                      : t('mortgageFields.previewNA')}
                  </span>
                </div>
                {/* The final payment is the residual payoff. It is shown when
                    it differs materially from the installment in EITHER
                    direction, so a standard schedule does not repeat its own
                    payment amount. The one-sided test hid the direction most
                    worth telling: a caller's payment count one short of the
                    clearing count leaves a last payment LARGER than every other,
                    and the borrower saw only the level installment. Read
                    defensively: an older API omits the field. */}
                {mortgagePreview.residualPayoffAmount != null &&
                  mortgagePreview.residualPayoffAmount >= 0 &&
                  Math.abs(
                    mortgagePreview.paymentAmount -
                      mortgagePreview.residualPayoffAmount,
                  ) > 1 && (
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewFinalPayment')}</span>{' '}
                      <span className="font-medium">
                        {formatCurrency(mortgagePreview.residualPayoffAmount, watchedCurrency)}
                      </span>
                    </div>
                  )}
                <div className="col-span-2">
                  <span className="text-gray-500 dark:text-gray-400">{t('mortgageFields.previewPayoffDate')}</span>{' '}
                  <span className="font-medium">
                    {mortgagePreview.totalPayments > 0
                      ? formatDate(mortgagePreview.endDate)
                      : t('mortgageFields.previewNA')}
                  </span>
                </div>
              </div>
            </div>
          )}
          {isLoadingPreview && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {t('mortgageFields.calculatingPreview')}
            </div>
          )}
        </>
      )}

      {/* Payment recognition (interest category + overpayment category / payee /
          memo). Always shown so an existing loan can be configured on edit. */}
      <OverpaymentRecognitionFields
        categories={categories}
        selectedInterestCategoryId={selectedInterestCategoryId}
        onInterestCategoryChange={handleInterestCategoryChange}
        interestBookingMode={interestBookingMode}
        onInterestBookingModeChange={handleInterestBookingModeChange}
        selectedOverpaymentCategoryId={selectedOverpaymentCategoryId}
        onOverpaymentCategoryChange={handleOverpaymentCategoryChange}
        selectedOverpaymentPayeeId={selectedOverpaymentPayeeId}
        onOverpaymentPayeeChange={handleOverpaymentPayeeChange}
        register={register}
        errors={errors}
      />
    </div>
  );
}
