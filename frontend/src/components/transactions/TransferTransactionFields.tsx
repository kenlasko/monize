'use client';

import { UseFormRegister, FieldErrors, UseFormSetValue } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';
import { getCurrencySymbol } from '@/lib/format';

interface CrossCurrencyInfo {
  fromCurrency: string;
  toCurrency: string;
  fromAccountName: string;
  toAccountName: string;
}

interface TransferTransactionFieldsProps {
  register: UseFormRegister<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  accounts: Account[];
  setValue: UseFormSetValue<any>;
  transferToAccountId: string;
  setTransferToAccountId: (id: string) => void;
  transferTargetAmount: number | undefined;
  setTransferTargetAmount: (amount: number | undefined) => void;
  transferPayeeId: string;
  transferPayeeName: string;
  setTransferPayeeId: (id: string) => void;
  setTransferPayeeName: (name: string) => void;
  crossCurrencyInfo: CrossCurrencyInfo | null;
  payees: Payee[];
  transaction?: Transaction;
}

export function TransferTransactionFields({
  register,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  accounts,
  setValue,
  transferToAccountId,
  setTransferToAccountId,
  transferTargetAmount,
  setTransferTargetAmount,
  transferPayeeId,
  transferPayeeName,
  setTransferPayeeId,
  setTransferPayeeName,
  crossCurrencyInfo,
  payees,
  transaction,
}: TransferTransactionFieldsProps) {
  return (
    <div className="space-y-4">
      {/* Row 1: Date */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="Date"
          type="date"
          error={errors.transactionDate?.message as string | undefined}
          {...register('transactionDate')}
        />
      </div>

      {/* Row 2: From and To Accounts side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label="From Account"
          error={errors.accountId?.message as string | undefined}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: 'Select account...' },
            ...accounts
              .filter(account =>
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === watchedAccountId)
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(account => ({
                value: account.id,
                label: `${account.name} (${account.currencyCode})${account.isClosed ? ' (Closed)' : ''}`,
                disabled: account.isClosed && account.id !== watchedAccountId,
              })
            ),
          ]}
          {...register('accountId')}
        />
        <Select
          label="To Account"
          value={transferToAccountId}
          onChange={(e) => {
            setTransferToAccountId(e.target.value);
            setTransferTargetAmount(undefined);
          }}
          options={[
            { value: '', label: 'Select destination account...' },
            ...accounts
              .filter(account =>
                account.id !== watchedAccountId &&
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === transferToAccountId)
              )
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(account => ({
                value: account.id,
                label: `${account.name} (${account.currencyCode})${account.isClosed ? ' (Closed)' : ''}`,
                disabled: account.isClosed && account.id !== transferToAccountId,
              })),
          ]}
        />
      </div>

      {/* Row 3: Transfer Amount under From, Received Amount under To (for cross-currency) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <CurrencyInput
            label={`Transfer Amount${crossCurrencyInfo ? ` (${crossCurrencyInfo.fromCurrency})` : ''}`}
            prefix={getCurrencySymbol(watchedCurrencyCode)}
            value={watchedAmount}
            onChange={(value) => setValue('amount', value !== undefined ? Math.abs(value) : 0, { shouldValidate: true })}
            allowNegative={false}
            error={errors.amount?.message as string | undefined}
          />
          {!crossCurrencyInfo && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Amount must be positive for transfers
            </p>
          )}
        </div>

        {/* Received Amount - only for cross-currency transfers */}
        {crossCurrencyInfo && (
          <div>
            <CurrencyInput
              label={`Amount Received (${crossCurrencyInfo.toCurrency})`}
              prefix={getCurrencySymbol(crossCurrencyInfo.toCurrency)}
              value={transferTargetAmount}
              onChange={(value) => setTransferTargetAmount(value !== undefined ? Math.abs(value) : undefined)}
              allowNegative={false}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Amount received after currency conversion
            </p>
          </div>
        )}
      </div>

      {/* Row 4: Payee and Reference Number */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Combobox
          label="Payee (Optional)"
          placeholder="Select or type payee name..."
          options={payees.map(payee => ({
            value: payee.id,
            label: payee.name,
          }))}
          value={transferPayeeId}
          initialDisplayValue={transferPayeeName}
          onChange={(payeeId: string, payeeName: string) => {
            setTransferPayeeId(payeeId);
            setTransferPayeeName(payeeName);
          }}
          allowCustomValue={true}
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
