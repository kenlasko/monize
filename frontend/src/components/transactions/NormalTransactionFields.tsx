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
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

interface NormalTransactionFieldsProps {
  register: UseFormRegister<any>;
  setValue: UseFormSetValue<any>;
  errors: FieldErrors;
  watchedAccountId: string;
  watchedAmount: number;
  watchedCurrencyCode: string;
  watchedPayeeName?: string;
  accounts: Account[];
  selectedPayeeId: string;
  selectedCategoryId: string;
  payees: Payee[];
  payeeAliasMap: Record<string, string[]>;
  categoryOptions: Array<{ value: string; label: string }>;
  handlePayeeChange: (payeeId: string, payeeName: string) => void;
  handlePayeeCreate: (name: string) => void;
  handleCategoryChange: (categoryId: string, name: string) => void;
  handleCategoryCreate: (name: string) => void;
  handleAmountChange: (value: number | undefined) => void;
  handleModeChange: (mode: 'normal' | 'split' | 'transfer') => void;
  /** Quick-fill the form from a previous transaction. When undefined, the
   *  history button is hidden (e.g. when editing). */
  onQuickFill?: (transaction: Transaction) => void;
  transaction?: Transaction;
  createdAtSlot?: ReactNode;
  /** Foreign-currency entry: button placed left of the Amount input. */
  currencyPickerSlot?: ReactNode;
  /** Foreign-currency entry: the converted account-currency amount input, placed
   *  beside the Amount input (equal width). When set, the Amount row switches to
   *  a two-column layout and Reference Number moves to its own row. */
  convertedAmountSlot?: ReactNode;
  /** Foreign-currency entry: rate/fee captions rendered below the Amount row. */
  fxCaptionSlot?: ReactNode;
  /** Overrides the Amount input's value (the foreign total, when entering in a
   *  foreign currency). Defaults to watchedAmount (the account-currency amount). */
  amountValue?: number;
  /** Overrides the currency whose symbol prefixes the Amount input. Defaults to
   *  watchedCurrencyCode (the account currency). */
  amountCurrencyCode?: string;
  /** Overrides the Amount input's label (e.g. "Total in USD" when entering a
   *  foreign currency). Defaults to the plain "Amount" label. */
  amountLabel?: string;
}

export function NormalTransactionFields({
  register,
  setValue,
  errors,
  watchedAccountId,
  watchedAmount,
  watchedCurrencyCode,
  watchedPayeeName,
  accounts,
  selectedPayeeId,
  selectedCategoryId,
  payees,
  payeeAliasMap,
  categoryOptions,
  handlePayeeChange,
  handlePayeeCreate,
  handleCategoryChange,
  handleCategoryCreate,
  handleAmountChange,
  handleModeChange,
  onQuickFill,
  transaction,
  createdAtSlot,
  currencyPickerSlot,
  convertedAmountSlot,
  fxCaptionSlot,
  amountValue,
  amountCurrencyCode,
  amountLabel,
}: NormalTransactionFieldsProps) {
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

      {/* Row 2: Payee and Category */}
      <div
        {...tourAnchor(TOUR_ANCHORS.transactionFields)}
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        <div className="flex items-stretch space-x-2">
          <div className="flex-1 min-w-0">
            <Combobox
              label={t('form.fields.payee')}
              placeholder={t('form.placeholders.selectOrTypePayee')}
              options={payees.map(payee => ({
                value: payee.id,
                label: payee.name,
                subtitle: payee.defaultCategory?.name,
                keywords: payeeAliasMap[payee.id],
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
            // mt-6 (1.5rem) = label line-height (text-sm = 1.25rem) + mb-1 (0.25rem),
            // pushing the button past the Combobox label so it visually aligns
            // with the input box; flex-stretch fills the input's height.
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
          <div className="flex items-stretch sm:space-x-2">
            <div className="flex-1">
              <Combobox
                label={t('form.fields.category')}
                placeholder={t('form.placeholders.selectOrCreateCategory')}
                options={categoryOptions}
                value={selectedCategoryId}
                initialDisplayValue={transaction?.category?.name || ''}
                onChange={handleCategoryChange}
                onCreateNew={handleCategoryCreate}
                allowCustomValue={true}
                valueIsId
                error={errors.categoryId?.message as string | undefined}
              />
            </div>
            {/* mt-6 + flex-stretch matches the Combobox input height (see Payee row). */}
            <button
              {...tourAnchor(TOUR_ANCHORS.transactionSplit)}
              type="button"
              onClick={() => handleModeChange('split')}
              className="hidden sm:flex items-center justify-center flex-shrink-0 mt-6 px-3 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 whitespace-nowrap"
            >
              {t('form.splitTransaction')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => handleModeChange('split')}
            className="sm:hidden mt-2 w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
          >
            {t('form.splitTransaction')}
          </button>
        </div>
      </div>

      {/* Row 3: Amount (+ converted amount when entering a foreign currency) and
          Reference Number. In foreign mode the converted amount sits beside the
          Amount at equal width, and Reference Number drops to its own row. */}
      {(() => {
        const amountInput = (
          <CurrencyInput
            label={amountLabel ?? t('form.fields.amount')}
            prefix={getCurrencySymbol(amountCurrencyCode || watchedCurrencyCode)}
            value={amountValue !== undefined ? amountValue : watchedAmount}
            onChange={handleAmountChange}
            allowSignToggle
            error={errors.amount?.message as string | undefined}
          />
        );
        const referenceInput = (
          <Input
            label={t('form.fields.referenceNumber')}
            type="text"
            placeholder={t('form.placeholders.referenceNumber')}
            error={errors.referenceNumber?.message as string | undefined}
            {...register('referenceNumber')}
          />
        );
        return convertedAmountSlot ? (
          // On mobile each currency field and Reference Number sits on its own
          // line; on md+ the two currency fields share a row and Reference
          // Number takes the third column. items-start keeps each column its
          // natural height so the taller currency group does not stretch the
          // Reference Number field.
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
            {/* Source + target currency fields, with the conversion note below
                the pair (a sibling, not a grid row, so only its own small
                margin separates it) spanning both on desktop (md:col-span-2). */}
            <div className="md:col-span-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                <div className="flex items-stretch space-x-2">
                  {currencyPickerSlot}
                  <div className="flex-1 min-w-0">{amountInput}</div>
                </div>
                {convertedAmountSlot}
              </div>
              {fxCaptionSlot}
            </div>
            {referenceInput}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-stretch space-x-2">
              {currencyPickerSlot}
              <div className="flex-1 min-w-0">{amountInput}</div>
            </div>
            {referenceInput}
          </div>
        );
      })()}
    </div>
  );
}
