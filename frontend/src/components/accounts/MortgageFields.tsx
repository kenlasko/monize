'use client';

import { useState, useEffect, useCallback } from 'react';
import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Account, MortgageAmortizationPreview, MortgagePaymentFrequency } from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { createLogger } from '@/lib/logger';

const logger = createLogger('MortgageFields');

const mortgagePaymentFrequencyOptions = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'SEMI_MONTHLY', label: 'Semi-Monthly (1st & 15th)' },
  { value: 'BIWEEKLY', label: 'Bi-Weekly' },
  { value: 'ACCELERATED_BIWEEKLY', label: 'Accelerated Bi-Weekly' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'ACCELERATED_WEEKLY', label: 'Accelerated Weekly' },
];

const termOptions = [
  { value: '6', label: '6 months' },
  { value: '12', label: '1 year' },
  { value: '24', label: '2 years' },
  { value: '36', label: '3 years' },
  { value: '48', label: '4 years' },
  { value: '60', label: '5 years' },
  { value: '84', label: '7 years' },
  { value: '120', label: '10 years' },
];

const amortizationOptions = [
  { value: '180', label: '15 years' },
  { value: '240', label: '20 years' },
  { value: '300', label: '25 years' },
  { value: '360', label: '30 years' },
];

interface MortgageFieldsProps {
  watchedCurrency: string;
  openingBalance: number | undefined;
  interestRate: number | undefined;
  paymentStartDate: string | undefined;
  isCanadianMortgage: boolean | undefined;
  isVariableRate: boolean | undefined;
  amortizationMonths: number | undefined;
  mortgagePaymentFrequency: MortgagePaymentFrequency | undefined;
  setValue: UseFormSetValue<any>;
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
  accounts: Account[];
  categories: Category[];
  formatCurrency: (amount: number, currency?: string) => string;
}

export function MortgageFields({
  watchedCurrency,
  openingBalance,
  interestRate,
  paymentStartDate,
  isCanadianMortgage,
  isVariableRate,
  amortizationMonths,
  mortgagePaymentFrequency,
  setValue,
  register,
  errors,
  accounts,
  categories,
  formatCurrency,
}: MortgageFieldsProps) {
  const [mortgagePreview, setMortgagePreview] = useState<MortgageAmortizationPreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  const calculateMortgagePreview = useCallback(async () => {
    if (!openingBalance || !interestRate || !amortizationMonths || !mortgagePaymentFrequency || !paymentStartDate) {
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
        isCanadian: isCanadianMortgage || false,
        isVariableRate: isVariableRate || false,
      });
      setMortgagePreview(preview);
    } catch (error) {
      logger.error('Failed to calculate mortgage preview:', error);
      setMortgagePreview(null);
    } finally {
      setIsLoadingPreview(false);
    }
  }, [openingBalance, interestRate, amortizationMonths, mortgagePaymentFrequency, paymentStartDate, isCanadianMortgage, isVariableRate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      calculateMortgagePreview();
    }, 500);
    return () => clearTimeout(timer);
  }, [calculateMortgagePreview]);

  return (
    <div className="space-y-4 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Mortgage Details
      </h3>

      {/* Canadian Mortgage and Variable Rate checkboxes */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="isCanadianMortgage"
            className="mt-1 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            {...register('isCanadianMortgage')}
          />
          <label htmlFor="isCanadianMortgage" className="flex-1">
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Canadian Mortgage
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Uses semi-annual compounding for fixed rates (required by law in Canada)
            </span>
          </label>
        </div>

        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="isVariableRate"
            className="mt-1 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            {...register('isVariableRate')}
          />
          <label htmlFor="isVariableRate" className="flex-1">
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Variable Rate
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              Rate may change during the term (uses monthly compounding)
            </span>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Term Length"
          options={[
            { value: '', label: 'Select term...' },
            ...termOptions,
          ]}
          error={errors.termMonths?.message as string | undefined}
          {...register('termMonths', { valueAsNumber: true })}
        />

        <Select
          label="Amortization Period (required)"
          options={[
            { value: '', label: 'Select period...' },
            ...amortizationOptions,
          ]}
          error={errors.amortizationMonths?.message as string | undefined}
          {...register('amortizationMonths', { valueAsNumber: true })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Select
          label="Payment Frequency (required)"
          options={[
            { value: '', label: 'Select frequency...' },
            ...mortgagePaymentFrequencyOptions,
          ]}
          error={errors.mortgagePaymentFrequency?.message as string | undefined}
          {...register('mortgagePaymentFrequency')}
        />

        <Input
          label="First Payment Date (required)"
          type="date"
          error={errors.paymentStartDate?.message as string | undefined}
          {...register('paymentStartDate')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
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

        <Select
          label="Interest Category"
          options={[
            { value: '', label: 'Select category...' },
            ...categories
              .map(c => ({
                value: c.id,
                label: c.parentId
                  ? `${categories.find(p => p.id === c.parentId)?.name || ''}: ${c.name}`
                  : c.name,
              }))
              .sort((a, b) => a.label.localeCompare(b.label)),
          ]}
          error={errors.interestCategoryId?.message as string | undefined}
          {...register('interestCategoryId')}
        />
      </div>

      {/* Mortgage Amortization Preview */}
      {mortgagePreview && (
        <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Amortization Preview
          </h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Payment Amount:</span>{' '}
              <span className="font-medium">{formatCurrency(mortgagePreview.paymentAmount, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Effective Rate:</span>{' '}
              <span className="font-medium">{mortgagePreview.effectiveAnnualRate.toFixed(2)}%</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">First Payment Principal:</span>{' '}
              <span className="font-medium">{formatCurrency(mortgagePreview.principalPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">First Payment Interest:</span>{' '}
              <span className="font-medium">{formatCurrency(mortgagePreview.interestPayment, watchedCurrency)}</span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total Payments:</span>{' '}
              <span className="font-medium">
                {mortgagePreview.totalPayments > 0 ? mortgagePreview.totalPayments : 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Total Interest:</span>{' '}
              <span className="font-medium">
                {mortgagePreview.totalInterest > 0 ? formatCurrency(mortgagePreview.totalInterest, watchedCurrency) : 'N/A'}
              </span>
            </div>
            <div className="col-span-2">
              <span className="text-gray-500 dark:text-gray-400">Est. Payoff Date:</span>{' '}
              <span className="font-medium">
                {mortgagePreview.totalPayments > 0
                  ? new Date(mortgagePreview.endDate).toLocaleDateString()
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
