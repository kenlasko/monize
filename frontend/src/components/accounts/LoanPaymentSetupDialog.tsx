'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Combobox } from '@/components/ui/Combobox';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import {
  Account,
  DetectedLoanPayment,
  MORTGAGE_TYPES,
  MortgageType,
  PreviewLoanPaymentSetupData,
  PreviewLoanPaymentSetupResponse,
  SetupLoanPaymentsData,
  toMortgagePaymentFrequency,
} from '@/types/account';
import {
  PREPAYMENT_MODES,
  compoundingFor,
  storesConstantPayment,
  type PrepaymentMode,
} from '@/lib/mortgage-type';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import { getCurrencySymbol } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import toast from 'react-hot-toast';

const logger = createLogger('LoanPaymentSetupDialog');

interface LoanPaymentSetupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The debt being set up. The mortgage type is optional because the import
   * flow can build this from a freshly imported account the accounts list does
   * not hold yet -- but where the caller HAS it (`mortgageTypeOf(account)`), it
   * must travel: the dialog's own select is what it submits, so an unseeded
   * `ANNUITY` on a Canadian fixed-rate mortgage both turned its semi-annual
   * compounding off on save and left the quarterly/yearly options on a list the
   * server refuses.
   */
  loanAccount: {
    accountId: string;
    accountName: string;
    accountType: string;
    currencyCode?: string;
    mortgageType?: MortgageType;
    /** A LINEAR mortgage's stored mode; seeds the dialog's own select. */
    prepaymentMode?: PrepaymentMode | null;
  };
  accounts: Account[];
  onSetupComplete?: () => void;
}

export function LoanPaymentSetupDialog({
  isOpen,
  onClose,
  loanAccount,
  accounts,
  onSetupComplete,
}: LoanPaymentSetupDialogProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [isDetecting, setIsDetecting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [detected, setDetected] = useState<DetectedLoanPayment | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);

  // Form state
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [paymentFrequency, setPaymentFrequency] = useState('MONTHLY');
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [interestRate, setInterestRate] = useState<number | undefined>(undefined);
  const [interestCategoryId, setInterestCategoryId] = useState('');
  const [selectedPayeeId, setSelectedPayeeId] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [autoPost, setAutoPost] = useState(false);

  // Extra principal
  const [includeExtraPrincipal, setIncludeExtraPrincipal] = useState(false);
  const [extraPrincipal, setExtraPrincipal] = useState<number>(0);

  // Use detected split ratio from imported transactions
  const [useDetectedSplit, setUseDetectedSplit] = useState(false);

  const allPaymentFrequencyOptions = [
    { value: 'WEEKLY', label: t('loanPaymentSetup.frequencyOptions.weekly') },
    { value: 'BIWEEKLY', label: t('loanPaymentSetup.frequencyOptions.biweekly') },
    { value: 'SEMIMONTHLY', label: t('loanPaymentSetup.frequencyOptions.semiMonthly') },
    { value: 'MONTHLY', label: t('loanPaymentSetup.frequencyOptions.monthly') },
    { value: 'QUARTERLY', label: t('loanPaymentSetup.frequencyOptions.quarterly') },
    { value: 'YEARLY', label: t('loanPaymentSetup.frequencyOptions.yearly') },
  ];

  // Mortgage-specific
  const isMortgage = loanAccount.accountType === 'MORTGAGE';
  const currencySymbol = getCurrencySymbol(loanAccount.currencyCode || 'USD');
  const [mortgageType, setMortgageType] = useState<MortgageType>(
    loanAccount.mortgageType ?? 'ANNUITY',
  );
  const [prepaymentMode, setPrepaymentMode] = useState<PrepaymentMode>(
    loanAccount.prepaymentMode ?? 'SHORTEN_TERM',
  );

  // A semi-annually compounded mortgage is split by the mortgage helpers, which
  // have no quarterly or yearly cadence: the server answers 400 rather than
  // compute the split at a monthly rate, so offering those two here would be a
  // control whose only outcome is a failure the form cannot explain. Filtered
  // rather than validated on submit, so the choice never exists.
  //
  // The current selection is corrected by DERIVING the effective value instead
  // of writing state -- choosing the type while "Quarterly" is selected must not
  // submit a value the list no longer offers, and choosing another type restores
  // what the user had chosen.
  const restrictToMortgageCadences =
    isMortgage && compoundingFor(mortgageType) === 'SEMI_ANNUAL';
  const paymentFrequencyOptions = restrictToMortgageCadences
    ? allPaymentFrequencyOptions.filter(
        (option) => toMortgagePaymentFrequency(option.value) !== null,
      )
    : allPaymentFrequencyOptions;
  const effectivePaymentFrequency =
    restrictToMortgageCadences &&
    toMortgagePaymentFrequency(paymentFrequency) === null
      ? 'MONTHLY'
      : paymentFrequency;
  const [amortizationMonths, setAmortizationMonths] = useState<number | undefined>(undefined);
  const [termMonths, setTermMonths] = useState<number | undefined>(undefined);

  const sourceAccountOptions = buildAccountDropdownOptions(
    accounts,
    (a) =>
      a.id !== loanAccount.accountId &&
      !a.isClosed &&
      ['CHEQUING', 'SAVINGS', 'CASH'].includes(a.accountType),
    (a) => a.name,
  );

  const categoryOptions = getCategorySelectOptions(categories);

  const payeeOptions = payees.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const hasDetectedSplit =
    detected?.lastPrincipalAmount != null && detected?.lastInterestAmount != null;

  // Total payment including extra principal
  const totalPaymentAmount = paymentAmount + (includeExtraPrincipal ? extraPrincipal : 0);

  // A LINEAR or INTEREST_ONLY mortgage has no constant payment for the user to
  // state: the server prices its first installment from the ledger debt
  // through the first due date, and refuses a setup whose payment differs
  // (docs/specs/mortgage-types.md, section 5.5). The dialog shows the figure
  // the server's own preview prices, through the same code, and submits it.
  const derivesInstallment = isMortgage && !storesConstantPayment(mortgageType);
  const installmentRequest = useMemo<PreviewLoanPaymentSetupData | null>(
    () =>
      derivesInstallment && nextDueDate
        ? {
            paymentFrequency: effectivePaymentFrequency,
            nextDueDate,
            interestRate,
            mortgageType,
            prepaymentMode: mortgageType === 'LINEAR' ? prepaymentMode : undefined,
            amortizationMonths,
            extraPrincipal:
              includeExtraPrincipal && extraPrincipal > 0 ? extraPrincipal : undefined,
          }
        : null,
    [
      derivesInstallment, nextDueDate, effectivePaymentFrequency, interestRate,
      mortgageType, prepaymentMode, amortizationMonths, includeExtraPrincipal,
      extraPrincipal,
    ],
  );
  // The answer is kept with the request that produced it, so a late answer
  // for terms the user has since changed is never shown or submitted.
  const [installmentPreview, setInstallmentPreview] = useState<{
    request: PreviewLoanPaymentSetupData;
    result: PreviewLoanPaymentSetupResponse | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!isOpen || !installmentRequest) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await accountsApi.previewLoanPaymentSetup(
          loanAccount.accountId,
          installmentRequest,
        );
        if (!cancelled) {
          setInstallmentPreview({ request: installmentRequest, result, error: null });
        }
      } catch (error: any) {
        if (!cancelled) {
          logger.error('Failed to preview the first installment:', error);
          // A refusal from the pricing (a missing term, an accelerated
          // cadence) is one localized sentence and is shown as is; a DTO
          // validation failure answers with a list, which falls back to the
          // generic reason rather than running its entries together.
          const message = error?.response?.data?.message;
          setInstallmentPreview({
            request: installmentRequest,
            result: null,
            error: typeof message === 'string' ? message : null,
          });
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, installmentRequest, loanAccount.accountId]);
  const currentInstallment =
    installmentPreview && installmentPreview.request === installmentRequest
      ? installmentPreview
      : null;
  const derivedPaymentAmount =
    currentInstallment?.result?.derivesInstallment === true
      ? currentInstallment.result.paymentAmount
      : null;
  const submittedPaymentAmount = derivesInstallment
    ? derivedPaymentAmount
    : totalPaymentAmount;

  // Detect payment pattern on open
  useEffect(() => {
    if (!isOpen) return;

    const detect = async () => {
      setIsDetecting(true);
      try {
        const [result, cats, payeeList] = await Promise.all([
          accountsApi.detectLoanPayments(loanAccount.accountId),
          categoriesApi.getAll(),
          payeesApi.getAll('active'),
        ]);
        setCategories(cats);
        setPayees(payeeList);

        if (result) {
          setDetected(result);
          setPaymentAmount(result.paymentAmount);
          setPaymentFrequency(result.paymentFrequency);
          setSourceAccountId(result.sourceAccountId || '');
          setNextDueDate(result.suggestedNextDueDate);
          setInterestRate(result.estimatedInterestRate ?? undefined);
          setInterestCategoryId(result.interestCategoryId || '');

          // Pre-fill extra principal if detected
          if (result.averageExtraPrincipal > 0) {
            setExtraPrincipal(result.averageExtraPrincipal);
            setIncludeExtraPrincipal(true);
          }

          // Enable detected split by default for mortgages when split data is available
          if (
            result.lastPrincipalAmount != null &&
            result.lastInterestAmount != null &&
            loanAccount.accountType === 'MORTGAGE'
          ) {
            setUseDetectedSplit(true);
          }
        } else {
          setDetected(null);
          setPaymentAmount(0);
          setPaymentFrequency('MONTHLY');
          setNextDueDate('');
          setInterestRate(undefined);
          setInterestCategoryId('');
          setSourceAccountId(sourceAccountOptions[0]?.value || '');
          setExtraPrincipal(0);
          setIncludeExtraPrincipal(false);
          setUseDetectedSplit(false);
        }
      } catch (error) {
        logger.error('Failed to detect payment pattern:', error);
        setDetected(null);
      } finally {
        setIsDetecting(false);
      }
    };

    detect();
  }, [isOpen, loanAccount.accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePayeeChange = useCallback((payeeId: string, name: string) => {
    setSelectedPayeeId(payeeId);
    setPayeeName(name);
  }, []);

  const handlePayeeCreate = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      const newPayee = await payeesApi.create({ name: name.trim() });
      setPayees((prev) => [...prev, newPayee]);
      setSelectedPayeeId(newPayee.id);
      setPayeeName(newPayee.name);
      toast.success(t('toasts.payeeCreated', { name }));
    } catch (error: any) {
      const message = error?.response?.data?.message || t('toasts.payeeCreateFailed');
      toast.error(message);
    }
  }, [t]);

  const handleSubmit = useCallback(async () => {
    if (!submittedPaymentAmount || !sourceAccountId || !nextDueDate) {
      toast.error(t('loanPaymentSetup.fillRequiredFields'));
      return;
    }

    setIsSubmitting(true);
    try {
      const data: SetupLoanPaymentsData = {
        paymentAmount: submittedPaymentAmount,
        // The value the control shows, not the raw selection behind it: a
        // Canadian mortgage's list drops the cadences the server refuses, so
        // submitting the pre-restriction choice would send exactly the 400 the
        // filtering exists to prevent.
        paymentFrequency: effectivePaymentFrequency,
        sourceAccountId,
        nextDueDate,
        interestRate,
        interestCategoryId: interestCategoryId || undefined,
        payeeId: selectedPayeeId || undefined,
        payeeName: payeeName || undefined,
        autoPost,
      };

      if (includeExtraPrincipal && extraPrincipal > 0) {
        data.extraPrincipal = extraPrincipal;
      }

      // A derived installment is split by its method; the server ignores a
      // detected interest for it, so none is sent.
      if (!derivesInstallment && useDetectedSplit && detected?.lastInterestAmount != null) {
        data.detectedInterestAmount = detected.lastInterestAmount;
      }

      if (isMortgage) {
        data.mortgageType = mortgageType;
        if (mortgageType === 'LINEAR') data.prepaymentMode = prepaymentMode;
        data.amortizationMonths = amortizationMonths;
        data.termMonths = termMonths;
      }

      await accountsApi.setupLoanPayments(loanAccount.accountId, data);
      toast.success(t('loanPaymentSetup.toasts.setupComplete', { account: loanAccount.accountName }));
      onSetupComplete?.();
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.message || 'Failed to set up payments';
      toast.error(message);
      logger.error('Failed to set up loan payments:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    submittedPaymentAmount, effectivePaymentFrequency, sourceAccountId, nextDueDate,
    interestRate, interestCategoryId, selectedPayeeId, payeeName, autoPost,
    includeExtraPrincipal, extraPrincipal, useDetectedSplit, detected,
    derivesInstallment, isMortgage, mortgageType, prepaymentMode,
    amortizationMonths, termMonths, loanAccount, onSetupComplete, onClose, t,
  ]);

  const confidenceLabel = detected
    ? detected.confidence >= 0.7
      ? 'High'
      : detected.confidence >= 0.4
        ? 'Medium'
        : 'Low'
    : null;


  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {isMortgage ? t('loanPaymentSetup.titleMortgage') : t('loanPaymentSetup.titleLoan')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {loanAccount.accountName}
        </p>

        {isDetecting ? (
          <div className="flex flex-col items-center py-8">
            <LoadingSpinner />
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {t('loanPaymentSetup.analyzingHistory')}
            </p>
          </div>
        ) : (
          <>
            {detected && detected.paymentCount > 0 && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4">
                <p className="text-sm text-blue-800 dark:text-blue-300">
                  {t('loanPaymentSetup.detectedPayments', { count: detected.paymentCount, from: detected.firstPaymentDate, to: detected.lastPaymentDate })}
                  {confidenceLabel && (
                    <span className="ml-1">
                      {t('loanPaymentSetup.confidence')} <strong>{confidenceLabel}</strong>
                    </span>
                  )}
                </p>
                {hasDetectedSplit && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    {t('loanPaymentSetup.lastSplit', { currency: currencySymbol, principal: detected.lastPrincipalAmount?.toFixed(2) ?? '', interest: detected.lastInterestAmount?.toFixed(2) ?? '' })}
                  </p>
                )}
                {detected.extraPrincipalCount > 0 && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
                    {t('loanPaymentSetup.extraPayments', { count: detected.extraPrincipalCount, currency: currencySymbol, avg: detected.averageExtraPrincipal.toFixed(2) })}
                  </p>
                )}
                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                  {t('loanPaymentSetup.reviewValues')}
                </p>
              </div>
            )}

            <div className="space-y-4">
              {/* Payment Amount: stated by the user, or for a mortgage without
                  a constant payment the first installment the server prices */}
              {derivesInstallment ? (
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('loanPaymentSetup.firstInstallment')}
                  </p>
                  {derivedPaymentAmount != null ? (
                    <>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {formatCurrency(derivedPaymentAmount, loanAccount.currencyCode)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t('loanPaymentSetup.firstInstallmentHelp', {
                          date: formatDate(nextDueDate),
                        })}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {!nextDueDate
                        ? t('loanPaymentSetup.firstInstallmentPending')
                        : currentInstallment
                          ? (currentInstallment.error ??
                            t('loanPaymentSetup.firstInstallmentFailed'))
                          : t('loanPaymentSetup.firstInstallmentCalculating')}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <CurrencyInput
                    label={t('loanPaymentSetup.regularPaymentAmount')}
                    value={paymentAmount || undefined}
                    onChange={(val) => setPaymentAmount(val ?? 0)}
                    prefix={currencySymbol}
                  />
                </div>
              )}

              {/* Extra Principal */}
              <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={includeExtraPrincipal}
                    onChange={(e) => setIncludeExtraPrincipal(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {t('loanPaymentSetup.includeExtraPrincipal')}
                  </span>
                </label>
                {includeExtraPrincipal && (
                  <div className="ml-6">
                    <CurrencyInput
                      label={t('loanPaymentSetup.extraPrincipalPerPayment')}
                      value={extraPrincipal || undefined}
                      onChange={(val) => setExtraPrincipal(val ?? 0)}
                      prefix={currencySymbol}
                    />
                    {!derivesInstallment && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t('loanPaymentSetup.totalPayment', { currency: currencySymbol, amount: totalPaymentAmount.toFixed(2) })}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Use Detected Split Ratio: an annuity's split only; a derived
                  installment is split by its method */}
              {hasDetectedSplit && !derivesInstallment && (
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={useDetectedSplit}
                      onChange={(e) => setUseDetectedSplit(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('loanPaymentSetup.useDetectedSplit')}
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 ml-6">
                    {useDetectedSplit
                      ? t('loanPaymentSetup.useDetectedSplitDesc', { currency: currencySymbol, interest: detected!.lastInterestAmount!.toFixed(2) })
                      : t('loanPaymentSetup.calculateFromRate')}
                  </p>
                </div>
              )}

              {/* Payment Frequency */}
              <div>
                <Select
                  label={t('loanPaymentSetup.paymentFrequency')}
                  value={effectivePaymentFrequency}
                  onChange={(e) => setPaymentFrequency(e.target.value)}
                  options={paymentFrequencyOptions}
                />
              </div>

              {/* Source Account */}
              <div>
                <Select
                  label={t('loanPaymentSetup.paymentFromAccount')}
                  value={sourceAccountId}
                  onChange={(e) => setSourceAccountId(e.target.value)}
                  options={[
                    { value: '', label: t('loanPaymentSetup.selectAccount') },
                    ...sourceAccountOptions,
                  ]}
                />
              </div>

              {/* Next Due Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('loanPaymentSetup.nextPaymentDate')}
                </label>
                <DateInput
                  value={nextDueDate}
                  onDateChange={(date) => setNextDueDate(date)}
                  onChange={() => {}}
                />
              </div>

              {/* Interest Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('loanPaymentSetup.annualInterestRate')}
                </label>
                <NumericInput
                  decimalPlaces={2}
                  min={0}
                  max={100}
                  suffix="%"
                  value={interestRate}
                  onChange={setInterestRate}
                  placeholder={t('loanPaymentSetup.interestRatePlaceholder')}
                />
                {detected?.estimatedInterestRate && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('loanPaymentSetup.estimatedFromHistory', { rate: detected.estimatedInterestRate })}
                  </p>
                )}
              </div>

              {/* Interest Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('loanPaymentSetup.interestExpenseCategory')}
                </label>
                <Combobox
                  value={interestCategoryId}
                  onChange={(val) => setInterestCategoryId(val)}
                  options={categoryOptions}
                  placeholder={t('loanPaymentSetup.selectCategory')}
                />
                {detected?.interestCategoryName && !interestCategoryId && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t('loanPaymentSetup.detectedCategory', { name: detected.interestCategoryName })}
                  </p>
                )}
              </div>

              {/* Payee */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('loanPaymentSetup.payeeLender')}
                </label>
                <Combobox
                  value={selectedPayeeId}
                  onChange={handlePayeeChange}
                  onCreateNew={handlePayeeCreate}
                  options={payeeOptions}
                  placeholder={t('loanPaymentSetup.selectOrCreatePayee')}
                  allowCustomValue={true}
                  valueIsId
                />
              </div>

              {/* Mortgage-specific fields */}
              {isMortgage && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
                    {t('loanPaymentSetup.mortgageDetails')}
                  </h3>

                  <div className="space-y-3">
                    <div>
                      <Select
                        id="loan-setup-mortgage-type"
                        label={t('mortgageFields.type.label')}
                        value={mortgageType}
                        onChange={(e) =>
                          setMortgageType(
                            MORTGAGE_TYPES.find((type) => type === e.target.value) ??
                              mortgageType,
                          )
                        }
                        options={MORTGAGE_TYPES.map((type) => ({
                          value: type,
                          label: t(`mortgageFields.type.${type}`),
                        }))}
                      />
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t(`mortgageFields.type.help.${mortgageType}`)}
                      </p>
                    </div>

                    {mortgageType === 'LINEAR' && (
                      <div>
                        <Select
                          id="loan-setup-prepayment-mode"
                          label={t('mortgageFields.prepaymentMode.label')}
                          value={prepaymentMode}
                          onChange={(e) =>
                            setPrepaymentMode(
                              PREPAYMENT_MODES.find((mode) => mode === e.target.value) ??
                                prepaymentMode,
                            )
                          }
                          options={PREPAYMENT_MODES.map((mode) => ({
                            value: mode,
                            label: t(`mortgageFields.prepaymentMode.${mode}`),
                          }))}
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          {t('mortgageFields.prepaymentMode.help')}
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {t('loanPaymentSetup.amortizationMonths')}
                        </label>
                        <NumericInput
                          decimalPlaces={0}
                          min={1}
                          max={600}
                          value={amortizationMonths}
                          onChange={setAmortizationMonths}
                          placeholder="e.g., 300"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {t('loanPaymentSetup.termMonths')}
                        </label>
                        <NumericInput
                          decimalPlaces={0}
                          min={1}
                          max={600}
                          value={termMonths}
                          onChange={setTermMonths}
                          placeholder="e.g., 60"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Auto-post */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoPost}
                  onChange={(e) => setAutoPost(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t('loanPaymentSetup.autoPost')}
                </span>
              </label>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('loanPaymentSetup.skip')}
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting || !submittedPaymentAmount || !sourceAccountId || !nextDueDate}
              >
                {isSubmitting ? t('loanPaymentSetup.settingUp') : t('loanPaymentSetup.setUpPayments')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
