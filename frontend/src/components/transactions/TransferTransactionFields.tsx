'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { UseFormRegister, FieldErrors, UseFormSetValue } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';
import { getCurrencySymbol } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';

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
  payeeAliasMap?: Record<string, string[]>;
  categoryOptions: Array<{ value: string; label: string }>;
  selectedCategoryId: string;
  handleCategoryChange: (categoryId: string, name: string) => void;
  handleCategoryCreate: (name: string) => void;
  transaction?: Transaction;
  createdAtSlot?: ReactNode;
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
  payeeAliasMap,
  categoryOptions,
  selectedCategoryId,
  handleCategoryChange,
  handleCategoryCreate,
  transaction,
  createdAtSlot,
}: TransferTransactionFieldsProps) {
  const t = useTranslations('transactions');
  // A delegate may only have READ on one side of a transfer; the other
  // account is not in `accounts` (and the backend masked it). Surface it as
  // a read-only "Hidden account" option so the field is not blank.
  const hiddenAccountOption = (id: string) => {
    if (!id || accounts.some((a) => a.id === id)) return [];
    const masked =
      transaction?.linkedTransaction?.account?.name || 'Hidden account';
    return [{ value: id, label: masked, disabled: true }];
  };

  return (
    <div className="space-y-4">
      {/* Row 1: Date and optionally Create Date */}
      <div className={`grid grid-cols-1 gap-4 ${createdAtSlot ? 'md:grid-cols-2' : 'md:grid-cols-2'}`}>
        <DateInput
          label={t('form.fields.date')}
          error={errors.transactionDate?.message as string | undefined}
          onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
          {...register('transactionDate')}
        />
        {createdAtSlot}
      </div>

      {/* Row 2: From and To Accounts side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label={t('form.fields.fromAccount')}
          error={errors.accountId?.message as string | undefined}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: t('form.placeholders.selectAccount') },
            ...hiddenAccountOption(watchedAccountId),
            ...buildAccountDropdownOptions(
              accounts,
              (account) =>
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === watchedAccountId),
            ),
          ]}
          {...register('accountId')}
        />
        <Select
          label={t('form.fields.toAccount')}
          value={transferToAccountId}
          onChange={(e) => {
            setTransferToAccountId(e.target.value);
            setTransferTargetAmount(undefined);
          }}
          options={[
            { value: '', label: t('form.placeholders.selectDestinationAccount') },
            ...hiddenAccountOption(transferToAccountId),
            ...buildAccountDropdownOptions(
              accounts,
              (account) =>
                account.id !== watchedAccountId &&
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === transferToAccountId),
            ),
          ]}
        />
      </div>

      {/* Row 3: Transfer Amount under From, Received Amount under To (for cross-currency) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <CurrencyInput
            label={crossCurrencyInfo ? t('form.fields.transferAmountWithCurrency', { currency: crossCurrencyInfo.fromCurrency }) : t('form.fields.transferAmount')}
            prefix={getCurrencySymbol(watchedCurrencyCode)}
            value={watchedAmount}
            onChange={(value) => setValue('amount', value !== undefined ? Math.abs(value) : 0, { shouldValidate: true })}
            allowNegative={false}
            error={errors.amount?.message as string | undefined}
          />
          {!crossCurrencyInfo && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('form.transferAmountNote')}
            </p>
          )}
        </div>

        {/* Received Amount - only for cross-currency transfers */}
        {crossCurrencyInfo && (
          <div>
            <CurrencyInput
              label={t('form.fields.amountReceived', { currency: crossCurrencyInfo.toCurrency })}
              prefix={getCurrencySymbol(crossCurrencyInfo.toCurrency)}
              value={transferTargetAmount}
              onChange={(value) => setTransferTargetAmount(value !== undefined ? Math.abs(value) : undefined)}
              allowNegative={false}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('form.amountReceivedNote')}
            </p>
          </div>
        )}
      </div>

      {/* Row 4: Payee and Reference Number */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Combobox
          label={t('form.fields.payeeOptional')}
          placeholder={t('form.placeholders.selectOrTypePayee')}
          options={payees.map(payee => ({
            value: payee.id,
            label: payee.name,
            keywords: payeeAliasMap?.[payee.id],
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
          label={t('form.fields.referenceNumber')}
          type="text"
          placeholder={t('form.placeholders.referenceNumber')}
          error={errors.referenceNumber?.message as string | undefined}
          {...register('referenceNumber')}
        />
      </div>

      {/* Row 5: Optional category. A transfer never counts as income/expense,
          but a category lets it appear in the monthly category breakdown
          (e.g. tracking monthly investment contributions). */}
      <div>
        <Combobox
          label={t('form.fields.categoryOptional')}
          placeholder={t('form.placeholders.selectOrCreateCategory')}
          options={categoryOptions}
          value={selectedCategoryId}
          initialDisplayValue={transaction?.category?.name || ''}
          onChange={handleCategoryChange}
          onCreateNew={handleCategoryCreate}
          allowCustomValue={true}
          error={errors.categoryId?.message as string | undefined}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('form.transferCategoryNote')}
        </p>
      </div>
    </div>
  );
}
