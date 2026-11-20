'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import {
  Account,
  AmortizationPreview,
  PAYMENT_FREQUENCIES,
  PaymentFrequency,
  InterestBookingMode,
} from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import { useDateFormat } from '@/hooks/useDateFormat';
import { OverpaymentRecognitionFields } from './OverpaymentRecognitionFields';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';
import { useForeignCurrencyLabel } from '@/hooks/useMainAccountName';

const logger = createLogger('LoanFields');

interface LoanFieldsProps {
  currencySymbol: string;
  watchedCurrency: string;
  paymentAmount: number | undefined;
  interestRate: number | undefined;
  paymentFrequency: PaymentFrequency | undefined;
  paymentStartDate: string | undefined;
  openingBalance: number | undefined;
  /** The watched Payment From account, so the picker shows what the form holds. */
  sourceAccountId?: string;
  setValue: UseFormSetValue<any>;
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
  accounts: Account[];
  categories: Category[];
  formatCurrency: (amount: number, currency?: string) => string;
  selectedInterestCategoryId: string;
  handleInterestCategoryChange: (categoryId: string) => void;
  interestBookingMode: InterestBookingMode;
  handleInterestBookingModeChange: (mode: InterestBookingMode) => void;
  selectedOverpaymentCategoryId: string;
  handleOverpaymentCategoryChange: (categoryId: string) => void;
  selectedOverpaymentPayeeId: string;
  handleOverpaymentPayeeChange: (payeeId: string) => void;
}

/**
 * Catalog key for each loan cadence. A `Record` over the shared list, so adding
 * a frequency without a label is a compile error rather than a
 * `loanFields.frequencyOptions.undefined` rendered as its own key path.
 */
const LOAN_FREQUENCY_LABEL_KEY: Record<PaymentFrequency, string> = {
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  SEMIMONTHLY: 'semiMonthly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
};

export function LoanFields({
  currencySymbol,
  watchedCurrency,
  paymentAmount,
  interestRate,
  paymentFrequency,
  paymentStartDate,
  openingBalance,
  sourceAccountId,
  setValue,
  register,
  errors,
  accounts,
  categories,
  formatCurrency,
  selectedInterestCategoryId,
  handleInterestCategoryChange,
  interestBookingMode,
  handleInterestBookingModeChange,
  selectedOverpaymentCategoryId,
  handleOverpaymentCategoryChange,
  selectedOverpaymentPayeeId,
  handleOverpaymentPayeeChange,
}: LoanFieldsProps) {
  const t = useTranslations('accounts');
  const foreignCurrencyLabel = useForeignCurrencyLabel();
  const { formatDate } = useDateFormat();

  // Every cadence `PAYMENT_FREQUENCIES` admits, in its order -- built from the
  // shared list rather than typed out again. The local copy was missing
  // SEMIMONTHLY, so the cadence the setup dialog writes, the DTO validates and
  // `AccountForm`'s Zod enum accepts could not be chosen when CREATING a loan:
  // the only route to a semi-monthly loan was the setup dialog.
  // `loan-frequency.guard.test.ts` reads both option lists out of the source.
  const paymentFrequencyOptions = PAYMENT_FREQUENCIES.map((value) => ({
    value,
    label: t(`loanFields.frequencyOptions.${LOAN_FREQUENCY_LABEL_KEY[value]}`),
  }));
  const [amortizationPreview, setAmortizationPreview] = useState<AmortizationPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  const calculatePreview = useCallback(async () => {
    // `interestRate == null`, not `!interestRate`: 0% is a real loan rate (an
    // interest-free family loan, a promotional deal; LoanPreviewDto validates
    // `@Min(0)`), so a falsy check read a KNOWN zero as "not filled in" and
    // showed no preview at all. Same rule as MortgageFields. The others stay
    // falsy-checked: a zero balance, a zero payment or an empty date genuinely
    // mean unfilled.
    if (
      !openingBalance ||
      interestRate == null ||
      !paymentAmount ||
      !paymentFrequency ||
      !paymentStartDate
    ) {
      setAmortizationPreview(null);
      return;
    }

    setIsLoadingPreview(true);
    try {
      const preview = await accountsApi.previewLoanAmortization({
        loanAmount: openingBalance,
        interestRate,
        paymentAmount,
        paymentFrequency,
        paymentStartDate,
      });
      setAmortizationPreview(preview);
    } catch (error) {
      logger.error('Failed to calculate preview:', error);
      setAmortizationPreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [openingBalance, interestRate, paymentAmount, paymentFrequency, paymentStartDate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      calculatePreview();
    }, 500);
    return () => clearTimeout(timer);
  }, [calculatePreview]);


  return (
    <div className="space-y-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('loanFields.title')}
      </h3>

      <div className="grid grid-cols-2 gap-4">
        <CurrencyInput
          label={t('loanFields.paymentAmount')}
          prefix={currencySymbol}
          value={paymentAmount}
          onChange={(value) => setValue('paymentAmount', value, { shouldValidate: true })}
          error={errors.paymentAmount?.message as string | undefined}
          allowNegative={false}
        />

        <Select
          label={t('loanFields.paymentFrequency')}
          options={[
            { value: '', label: t('loanFields.selectFrequency') },
            ...paymentFrequencyOptions,
          ]}
          error={errors.paymentFrequency?.message as string | undefined}
          {...register('paymentFrequency')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <DateInput
          label={t('loanFields.firstPaymentDate')}
          error={errors.paymentStartDate?.message as string | undefined}
          onDateChange={(date) => setValue('paymentStartDate', date, { shouldDirty: true, shouldValidate: true })}
          {...register('paymentStartDate')}
        />

        <AccountSelect
          label={t('loanFields.paymentFromAccount')}
          options={[
            { value: '', label: t('loanFields.selectAccount') },
            ...buildAccountDropdownOptions(
              accounts,
              () => true,
              (a) => foreignCurrencyLabel(a.name, a.currencyCode),
            ),
          ]}
          error={errors.sourceAccountId?.message as string | undefined}
          value={sourceAccountId ?? ''}
          {...register('sourceAccountId')}
        />
      </div>

      <OverpaymentRecognitionFields
        categories={categories}
        selectedInterestCategoryId={selectedInterestCategoryId}
        onInterestCategoryChange={handleInterestCategoryChange}
        interestCategoryRequired
        interestBookingMode={interestBookingMode}
        onInterestBookingModeChange={handleInterestBookingModeChange}
        selectedOverpaymentCategoryId={selectedOverpaymentCategoryId}
        onOverpaymentCategoryChange={handleOverpaymentCategoryChange}
        selectedOverpaymentPayeeId={selectedOverpaymentPayeeId}
        onOverpaymentPayeeChange={handleOverpaymentPayeeChange}
        register={register}
        errors={errors}
      />

      {amortizationPreview && (
        <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            {t('loanFields.previewTitle')}
          </h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanFields.previewPrincipal')}</span>{' '}
              <span className="font-medium">{formatCurrency(amortizationPreview.principalPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanFields.previewInterest')}</span>{' '}
              <span className="font-medium">{formatCurrency(amortizationPreview.interestPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanFields.previewTotalPayments')}</span>{' '}
              <span className="font-medium">
                {amortizationPreview.totalPayments > 0 ? amortizationPreview.totalPayments : t('loanFields.previewNA')}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanFields.previewEstPayoff')}</span>{' '}
              <span className="font-medium">
                {amortizationPreview.totalPayments > 0
                  ? formatDate(amortizationPreview.endDate)
                  : t('loanFields.previewNA')}
              </span>
            </div>
          </div>
        </div>
      )}
      {isLoadingPreview && (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanFields.calculatingPreview')}
        </div>
      )}
    </div>
  );
}
