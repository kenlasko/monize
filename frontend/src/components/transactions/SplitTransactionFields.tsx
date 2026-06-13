'use client';

import { ReactNode, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
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
import { RecentTransactionsPopover } from './RecentTransactionsPopover';

interface SplitTransactionFieldsProps {
  register: UseFormRegister<any>;
  setValue: UseFormSetValue<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  watchedPayeeName?: string;
  accounts: Account[];
  selectedPayeeId: string;
  payees: Payee[];
  handlePayeeChange: (payeeId: string, payeeName: string) => void;
  handlePayeeCreate: (name: string) => void;
  handleAmountChange: (value: number | undefined) => void;
  /** Quick-fill from a previous transaction (split or normal). Hidden when undefined. */
  onQuickFill?: (transaction: Transaction) => void;
  transaction?: Transaction;
  createdAtSlot?: ReactNode;
}

export function SplitTransactionFields({
  register,
  setValue,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  watchedPayeeName,
  accounts,
  selectedPayeeId,
  payees,
  handlePayeeChange,
  handlePayeeCreate,
  handleAmountChange,
  onQuickFill,
  transaction,
  createdAtSlot,
}: SplitTransactionFieldsProps) {
  const t = useTranslations('transactions');
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const [showRecentPopover, setShowRecentPopover] = useState(false);

  return (
    <div className="space-y-4">
      {/* Row 1: Account, Date, and optionally Create Date */}
      <div className={`grid grid-cols-1 gap-4 ${createdAtSlot ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        <Select
          label={t('form.fields.account')}
          error={errors.accountId?.message as string | undefined}
          value={watchedAccountId || ''}
          options={[
            { value: '', label: t('form.placeholders.selectAccount') },
            ...buildAccountDropdownOptions(
              accounts,
              (account) =>
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === watchedAccountId),
            ),
          ]}
          {...register('accountId')}
        />
        <DateInput
          label={t('form.fields.date')}
          error={errors.transactionDate?.message as string | undefined}
          onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
          {...register('transactionDate')}
        />
        {createdAtSlot}
      </div>

      {/* Row 2: Payee and Total Amount */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-stretch space-x-2">
          <div className="flex-1 min-w-0">
            <Combobox
              label={t('form.fields.payee')}
              placeholder={t('form.placeholders.selectOrTypePayee')}
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
          </div>
          {onQuickFill && (
            <button
              ref={historyButtonRef}
              type="button"
              onClick={() => setShowRecentPopover((v) => !v)}
              aria-label={
                selectedPayeeId || watchedPayeeName
                  ? t('form.ariaHistoryForPayee')
                  : t('form.ariaHistory')
              }
              aria-haspopup="dialog"
              aria-expanded={showRecentPopover}
              title={t('form.historyTitle')}
              className="flex-shrink-0 mt-6 flex items-center justify-center px-2.5 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-5 w-5"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .2.08.39.22.53l3 3a.75.75 0 101.06-1.06L10.75 9.69V5z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
          {showRecentPopover && onQuickFill && (
            <RecentTransactionsPopover
              anchorRef={historyButtonRef}
              payeeId={selectedPayeeId || undefined}
              payeeName={selectedPayeeId ? undefined : watchedPayeeName || undefined}
              onSelect={(t) => {
                onQuickFill(t);
                setShowRecentPopover(false);
              }}
              onClose={() => setShowRecentPopover(false)}
            />
          )}
        </div>
        <CurrencyInput
          label={t('form.fields.totalAmount')}
          prefix={getCurrencySymbol(watchedCurrencyCode)}
          value={watchedAmount}
          onChange={handleAmountChange}
          error={errors.amount?.message as string | undefined}
        />
      </div>

      {/* Row 3: Reference Number, Description and Notes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Input
          label={t('form.fields.referenceNumber')}
          type="text"
          placeholder={t('form.placeholders.referenceNumber')}
          error={errors.referenceNumber?.message as string | undefined}
          {...register('referenceNumber')}
        />
        <Input
          label={t('form.fields.description')}
          type="text"
          placeholder={t('form.placeholders.optionalDescription')}
          error={errors.description?.message as string | undefined}
          {...register('description')}
        />
        <Input
          label={t('form.fields.notes')}
          type="text"
          placeholder={t('form.placeholders.optionalNotes')}
          error={errors.notes?.message as string | undefined}
          {...register('notes')}
        />
      </div>
    </div>
  );
}
