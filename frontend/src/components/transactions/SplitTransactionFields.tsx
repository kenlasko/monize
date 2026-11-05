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
import { entryDecimalPlaces, getCurrencySymbol } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { RecentTransactionsPopover } from './RecentTransactionsPopover';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';
import { NoteLinks } from '@/components/ui/LinkifiedText';

interface SplitTransactionFieldsProps {
  register: UseFormRegister<any>;
  setValue: UseFormSetValue<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  watchedPayeeName?: string;
  /** The live description, so its links can be offered under the field. */
  watchedDescription?: string;
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
  /** Foreign-currency entry: button placed left of the Total Amount input. */
  currencyPickerSlot?: ReactNode;
  /** Foreign-currency entry: the converted account-currency amount input, placed
   *  beside the Total Amount input (equal width). */
  convertedAmountSlot?: ReactNode;
  /** Foreign-currency entry: rate/fee captions rendered below the Total Amount. */
  fxCaptionSlot?: ReactNode;
  /** Overrides the Total Amount input's value (the foreign total). */
  amountValue?: number;
  /** Overrides the currency whose symbol prefixes the Total Amount input. */
  amountCurrencyCode?: string;
  /** Overrides the Total Amount input's label (e.g. "Total in USD" when entering
   *  a foreign currency). Defaults to the plain "Total Amount" label. */
  amountLabel?: string;
}

export function SplitTransactionFields({
  register,
  setValue,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  watchedPayeeName,
  watchedDescription,
  accounts,
  selectedPayeeId,
  payees,
  handlePayeeChange,
  handlePayeeCreate,
  handleAmountChange,
  onQuickFill,
  transaction,
  createdAtSlot,
  currencyPickerSlot,
  convertedAmountSlot,
  fxCaptionSlot,
  amountValue,
  amountCurrencyCode,
  amountLabel,
}: SplitTransactionFieldsProps) {
  const t = useTranslations('transactions');
  const accountOptionLabel = useAccountOptionLabel();
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
              accountOptionLabel,
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

      {/* Row 2: Payee and Total Amount. items-start keeps the Payee column its
          natural height so the taller amount column (converted field + note in
          foreign mode) does not stretch the Payee history button. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
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
              valueIsId
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
        <div>
          {(() => {
            const totalInput = (
              <CurrencyInput
                label={amountLabel ?? t('form.fields.totalAmount')}
                prefix={getCurrencySymbol(amountCurrencyCode || watchedCurrencyCode)}
                // A coin's total at its own places, as its lines are; undefined
                // (any ISO currency) keeps the input's two.
                decimalPlaces={entryDecimalPlaces(amountCurrencyCode || watchedCurrencyCode)}
                value={amountValue !== undefined ? amountValue : watchedAmount}
                onChange={handleAmountChange}
                allowSignToggle
                error={errors.amount?.message as string | undefined}
              />
            );
            // The currency picker stays attached to the total input.
            const pickerAndTotal = (
              <div className="flex items-stretch space-x-2">
                {currencyPickerSlot}
                <div className="flex-1 min-w-0">{totalInput}</div>
              </div>
            );
            // In foreign mode the total and converted amount each sit on their
            // own line on mobile and share a row from md up; the conversion note
            // renders below the pair so it spans both on desktop. Otherwise the
            // total fills the column.
            return convertedAmountSlot ? (
              // items-start keeps each column its natural height so the columns
              // do not stretch the total input or its attached currency picker.
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                {pickerAndTotal}
                {convertedAmountSlot}
              </div>
            ) : (
              pickerAndTotal
            );
          })()}
          {fxCaptionSlot}
        </div>
      </div>

      {/* Row 3: Reference Number and Description */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          maxLength={TRANSACTION_NOTE_MAX_LENGTH}
          error={errors.description?.message as string | undefined}
          {...register('description')}
        />
        <NoteLinks text={watchedDescription ?? ''} />
      </div>
    </div>
  );
}
