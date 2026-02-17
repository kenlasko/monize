'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Account, AmortizationPreview, PaymentFrequency } from '@/types/account';
import { Category } from '@/types/category';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { accountsApi } from '@/lib/accounts';
import { createLogger } from '@/lib/logger';

const logger = createLogger('LoanFields');

const paymentFrequencyOptions = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Every 2 Weeks' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
];

interface LoanFieldsProps {
  currencySymbol: string;
  watchedCurrency: string;
  paymentAmount: number | undefined;
  interestRate: number | undefined;
  paymentFrequency: PaymentFrequency | undefined;
  paymentStartDate: string | undefined;
  openingBalance: number | undefined;
  setValue: UseFormSetValue<any>;
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
  accounts: Account[];
  categories: Category[];
  formatCurrency: (amount: number, currency?: string) => string;
  selectedInterestCategoryId: string;
  handleInterestCategoryChange: (categoryId: string) => void;
}

export function LoanFields({
  currencySymbol,
  watchedCurrency,
  paymentAmount,
  interestRate,
  paymentFrequency,
  paymentStartDate,
  openingBalance,
  setValue,
  register,
  errors,
  accounts,
  categories,
  formatCurrency,
  selectedInterestCategoryId,
  handleInterestCategoryChange,
}: LoanFieldsProps) {
  const [amortizationPreview, setAmortizationPreview] = useState<AmortizationPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  const calculatePreview = useCallback(async () => {
    if (!openingBalance || !interestRate || !paymentAmount || !paymentFrequency || !paymentStartDate) {
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

  const interestCategoryOptions = useMemo(() =>
    buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    }),
  [categories]);

  const initialInterestCategoryName = useMemo(() => {
    if (!selectedInterestCategoryId) return '';
    const cat = categories.find(c => c.id === selectedInterestCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [selectedInterestCategoryId, categories]);

  return (
    <div className="space-y-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Loan Payment Details
      </h3>

      <div className="grid grid-cols-2 gap-4">
        <CurrencyInput
          label="Payment Amount (required)"
          prefix={currencySymbol}
          value={paymentAmount}
          onChange={(value) => setValue('paymentAmount', value, { shouldValidate: true })}
          error={errors.paymentAmount?.message as string | undefined}
          allowNegative={false}
        />

        <Select
          label="Payment Frequency (required)"
          options={[
            { value: '', label: 'Select frequency...' },
            ...paymentFrequencyOptions,
          ]}
          error={errors.paymentFrequency?.message as string | undefined}
          {...register('paymentFrequency')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="First Payment Date (required)"
          type="date"
          error={errors.paymentStartDate?.message as string | undefined}
          {...register('paymentStartDate')}
        />

        <Select
          label="Payment From Account (required)"
          options={[
            { value: '', label: 'Select account...' },
            ...accounts
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(a => ({
                value: a.id,
                label: `${a.name} (${a.currencyCode})`,
              })),
          ]}
          error={errors.sourceAccountId?.message as string | undefined}
          {...register('sourceAccountId')}
        />
      </div>

      <Combobox
        label="Interest Category"
        placeholder="Select category..."
        options={interestCategoryOptions}
        value={selectedInterestCategoryId}
        initialDisplayValue={initialInterestCategoryName}
        onChange={handleInterestCategoryChange}
        error={errors.interestCategoryId?.message as string | undefined}
      />

      {amortizationPreview && (
        <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Payment Preview (First Payment)
          </h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Principal:</span>{' '}
              <span className="font-medium">{formatCurrency(amortizationPreview.principalPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Interest:</span>{' '}
              <span className="font-medium">{formatCurrency(amortizationPreview.interestPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total Payments:</span>{' '}
              <span className="font-medium">
                {amortizationPreview.totalPayments > 0 ? amortizationPreview.totalPayments : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Est. Payoff:</span>{' '}
              <span className="font-medium">
                {amortizationPreview.totalPayments > 0
                  ? new Date(amortizationPreview.endDate).toLocaleDateString()
                  : 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}
      {isLoadingPreview && (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          Calculating preview...
        </div>
      )}
    </div>
  );
}
