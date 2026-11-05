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
import { Account, TransferCandidate } from '@/types/account';
import { Payee } from '@/types/payee';
import { entryDecimalPlaces, getCurrencySymbol } from '@/lib/format';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { useAuthStore } from '@/store/authStore';

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
  /** Cross-owner transfer targets beyond the effective user's own accounts. */
  transferCandidates?: TransferCandidate[];
  setValue: UseFormSetValue<any>;
  transferToAccountId: string;
  setTransferToAccountId: (id: string) => void;
  transferTargetAmount: number | undefined;
  setTransferTargetAmount: (amount: number | undefined) => void;
  /** Edit handlers for the two amount fields; default to plain setters. */
  onTransferAmountChange?: (amount: number | undefined) => void;
  onTransferTargetAmountChange?: (amount: number | undefined) => void;
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
  /** Absent when the surface cannot create categories (a joint account
   *  offers the owner's list and nothing more), which removes the
   *  "+ Create" row from the picker. */
  handleCategoryCreate?: (name: string) => void;
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
  transferCandidates,
  setValue,
  transferToAccountId,
  setTransferToAccountId,
  transferTargetAmount,
  setTransferTargetAmount,
  onTransferAmountChange,
  onTransferTargetAmountChange,
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
  const accountOptionLabel = useAccountOptionLabel();
  const isActing = useAuthStore((state) => !!state.actingAsUserId);
  const isEdit = !!transaction;

  // Cross-owner targets, gated by the per-account grant the current mode
  // needs (create vs edit). Closed candidates only stay visible while
  // selected, mirroring the own-account dropdown rule.
  const eligibleCandidates = (transferCandidates ?? []).filter(
    (candidate) =>
      (isEdit ? candidate.canEdit : candidate.canCreate) &&
      candidate.accountSubType !== 'INVESTMENT_BROKERAGE' &&
      (!candidate.isClosed ||
        candidate.id === watchedAccountId ||
        candidate.id === transferToAccountId),
  );

  // Appended group: separator, disabled group label, then the candidates.
  const candidateOptions = (excludeId: string) => {
    const list = eligibleCandidates.filter((c) => c.id !== excludeId);
    if (list.length === 0) return [];
    return [
      {
        value: '__candidates-separator__',
        label:
          '────────────────────',
        disabled: true,
      },
      {
        value: '__candidates-label__',
        label: isActing
          ? t('form.transferCandidates.yourAccounts')
          : t('form.transferCandidates.sharedWithYou'),
        disabled: true,
      },
      ...list.map((c) => ({
        value: c.id,
        label: t('form.transferCandidates.optionLabel', {
          name: c.name,
          currency: c.currencyCode,
          owner: c.ownerLabel,
        }),
      })),
    ];
  };

  // A user may only have READ on one side of a transfer (or none, after
  // unshare); the other account is in neither `accounts` nor the candidate
  // list, and the backend masked it. Surface it as a read-only
  // "Hidden account" option so the field is not blank.
  const hiddenAccountOption = (id: string) => {
    if (
      !id ||
      accounts.some((a) => a.id === id) ||
      eligibleCandidates.some((c) => c.id === id)
    ) {
      return [];
    }
    const masked =
      transaction?.linkedTransaction?.account?.name || 'Hidden account';
    return [{ value: id, label: masked, disabled: true }];
  };

  // Frozen link: the counterpart resolved to the hidden-account stub, so the
  // backend will reject structural edits -- disable From/To/Amount/Date up
  // front and keep only presentational fields editable.
  const counterpartLocked =
    isEdit &&
    (hiddenAccountOption(watchedAccountId).length > 0 ||
      hiddenAccountOption(transferToAccountId).length > 0);

  return (
    <div className="space-y-4">
      {/* Row 1: Date and optionally Create Date */}
      <div className={`grid grid-cols-1 gap-4 ${createdAtSlot ? 'md:grid-cols-2' : 'md:grid-cols-2'}`}>
        <DateInput
          label={t('form.fields.date')}
          error={errors.transactionDate?.message as string | undefined}
          onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
          disabled={counterpartLocked}
          {...register('transactionDate')}
        />
        {createdAtSlot}
      </div>

      {counterpartLocked && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('form.crossOwnerLockedNote')}
        </p>
      )}

      {/* Row 2: From and To Accounts side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label={t('form.fields.fromAccount')}
          error={errors.accountId?.message as string | undefined}
          value={watchedAccountId || ''}
          disabled={counterpartLocked}
          options={[
            { value: '', label: t('form.placeholders.selectAccount') },
            ...hiddenAccountOption(watchedAccountId),
            ...buildAccountDropdownOptions(
              accounts,
              (account) =>
                account.accountSubType !== 'INVESTMENT_BROKERAGE' &&
                (!account.isClosed || account.id === watchedAccountId),
              accountOptionLabel,
            ),
            ...candidateOptions(transferToAccountId),
          ]}
          {...register('accountId')}
        />
        <Select
          label={t('form.fields.toAccount')}
          value={transferToAccountId}
          disabled={counterpartLocked}
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
              accountOptionLabel,
            ),
            ...candidateOptions(watchedAccountId),
          ]}
        />
      </div>

      {/* Row 3: Transfer Amount, Received Amount (cross-currency only), and Reference Number */}
      <div className={`grid grid-cols-1 gap-4 ${crossCurrencyInfo ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        <div>
          <CurrencyInput
            label={
              crossCurrencyInfo
                ? t('form.fields.transferAmountInCurrency', { currency: crossCurrencyInfo.fromCurrency })
                : t('form.fields.transferAmount')
            }
            prefix={getCurrencySymbol(watchedCurrencyCode)}
            // A coin's amount at its own places, as useTransferFxAutofill
            // computes it; undefined (any ISO currency) keeps the input's two.
            decimalPlaces={entryDecimalPlaces(watchedCurrencyCode)}
            value={watchedAmount}
            onChange={(value) => {
              const next = value !== undefined ? Math.abs(value) : undefined;
              if (onTransferAmountChange) {
                onTransferAmountChange(next);
              } else {
                setValue('amount', next ?? 0, { shouldValidate: true });
              }
            }}
            allowNegative={false}
            disabled={counterpartLocked}
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
              label={t('form.fields.amountReceivedInCurrency', { currency: crossCurrencyInfo.toCurrency })}
              prefix={getCurrencySymbol(crossCurrencyInfo.toCurrency)}
              decimalPlaces={entryDecimalPlaces(crossCurrencyInfo.toCurrency)}
              value={transferTargetAmount}
              onChange={(value) =>
                (onTransferTargetAmountChange ?? setTransferTargetAmount)(
                  value !== undefined ? Math.abs(value) : undefined,
                )
              }
              allowNegative={false}
              disabled={counterpartLocked}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('form.amountReceivedNote')}
            </p>
          </div>
        )}

        <Input
          label={t('form.fields.referenceNumber')}
          type="text"
          placeholder={t('form.placeholders.referenceNumber')}
          error={errors.referenceNumber?.message as string | undefined}
          {...register('referenceNumber')}
        />
      </div>

      {/* Row 4: Payee and Category */}
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
          valueIsId
        />
        {/* A transfer never counts as income/expense, but a category lets it
            appear in the monthly category breakdown (e.g. investment contributions). */}
        <div>
          <Combobox
            label={t('form.fields.categoryOptional')}
            placeholder={t('form.placeholders.selectOrCreateCategory')}
            options={categoryOptions}
            value={selectedCategoryId}
            initialDisplayValue={transaction?.category?.name || ''}
            onChange={handleCategoryChange}
            onCreateNew={handleCategoryCreate}
            allowCustomValue={!!handleCategoryCreate}
            valueIsId
            error={errors.categoryId?.message as string | undefined}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('form.transferCategoryNote')}
          </p>
        </div>
      </div>
    </div>
  );
}
