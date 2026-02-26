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

interface SplitTransactionFieldsProps {
  register: UseFormRegister<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  accounts: Account[];
  selectedPayeeId: string;
  payees: Payee[];
  handlePayeeChange: (payeeId: string, payeeName: string) => void;
  handlePayeeCreate: (name: string) => void;
  handleAmountChange: (value: number | undefined) => void;
  transaction?: Transaction;
}

export function SplitTransactionFields({
  register,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  accounts,
  selectedPayeeId,
  payees,
  handlePayeeChange,
  handlePayeeCreate,
  handleAmountChange,
  transaction,
}: SplitTransactionFieldsProps) {
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

      {/* Row 2: Payee and Total Amount */}
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
        <CurrencyInput
          label="Total Amount"
          prefix={getCurrencySymbol(watchedCurrencyCode)}
          value={watchedAmount}
          onChange={handleAmountChange}
          error={errors.amount?.message as string | undefined}
        />
      </div>

      {/* Row 3: Reference Number and Description */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="Reference Number"
          type="text"
          placeholder="Cheque #, confirmation #..."
          error={errors.referenceNumber?.message as string | undefined}
          {...register('referenceNumber')}
        />
        <Input
          label="Description"
          type="text"
          placeholder="Optional description..."
          error={errors.description?.message as string | undefined}
          {...register('description')}
        />
      </div>
    </div>
  );
}
