'use client';

import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';
import { getCurrencySymbol } from '@/lib/format';

interface NormalTransactionFieldsProps {
  register: UseFormRegister<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  accounts: Account[];
  selectedPayeeId: string;
  selectedCategoryId: string;
  payees: Payee[];
  categoryOptions: Array<{ value: string; label: string }>;
  handlePayeeChange: (payeeId: string, payeeName: string) => void;
  handlePayeeCreate: (name: string) => void;
  handleCategoryChange: (categoryId: string, name: string) => void;
  handleCategoryCreate: (name: string) => void;
  handleAmountChange: (value: number | undefined) => void;
  handleModeChange: (mode: 'normal' | 'split' | 'transfer') => void;
  transaction?: Transaction;
}

export function NormalTransactionFields({
  register,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  accounts,
  selectedPayeeId,
  selectedCategoryId,
  payees,
  categoryOptions,
  handlePayeeChange,
  handlePayeeCreate,
  handleCategoryChange,
  handleCategoryCreate,
  handleAmountChange,
  handleModeChange,
  transaction,
}: NormalTransactionFieldsProps) {
  return (
    <div className="space-y-4">
      {/* Row 1: Account and Date */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="Account"
          error={errors.accountId?.message as string | undefined}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: 'Select account...' },
            ...accounts
              .filter(account =>
                !account.isClosed &&
                account.accountSubType !== 'INVESTMENT_BROKERAGE'
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(account => ({
                value: account.id,
                label: `${account.name} (${account.currencyCode})`,
              })
            ),
          ]}
          {...register('accountId')}
        />
        <Input
          label="Date"
          type="date"
          error={errors.transactionDate?.message as string | undefined}
          {...register('transactionDate')}
        />
      </div>

      {/* Row 2: Payee and Category */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Combobox
          label="Payee"
          placeholder="Select or type payee name..."
          options={payees.map(payee => ({
            value: payee.id,
            label: payee.name,
            subtitle: payee.defaultCategory?.name,
          }))}
          value={selectedPayeeId}
          initialDisplayValue={transaction?.payeeName || ''}
          onChange={handlePayeeChange}
          onCreateNew={handlePayeeCreate}
          allowCustomValue={true}
          error={errors.payeeName?.message as string | undefined}
        />
        <div>
          <div className="flex items-end sm:space-x-2">
            <div className="flex-1">
              <Combobox
                label="Category"
                placeholder="Select or create category..."
                options={categoryOptions}
                value={selectedCategoryId}
                initialDisplayValue={transaction?.category?.name || ''}
                onChange={handleCategoryChange}
                onCreateNew={handleCategoryCreate}
                allowCustomValue={true}
                error={errors.categoryId?.message as string | undefined}
              />
            </div>
            <button
              type="button"
              onClick={() => handleModeChange('split')}
              className="hidden sm:block px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 whitespace-nowrap"
            >
              Split Transaction
            </button>
          </div>
          <button
            type="button"
            onClick={() => handleModeChange('split')}
            className="sm:hidden mt-2 w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
          >
            Split Transaction
          </button>
        </div>
      </div>

      {/* Row 3: Amount and Reference Number */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CurrencyInput
          label="Amount"
          prefix={getCurrencySymbol(watchedCurrencyCode)}
          value={watchedAmount}
          onChange={handleAmountChange}
          error={errors.amount?.message as string | undefined}
        />
        <Input
          label="Reference Number"
          type="text"
          placeholder="Cheque #, confirmation #..."
          error={errors.referenceNumber?.message as string | undefined}
          {...register('referenceNumber')}
        />
      </div>
    </div>
  );
}
