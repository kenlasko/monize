'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';
import { showErrorToast } from '@/lib/errors';
import { UseFormModalReturn } from '@/hooks/useFormModal';
import type { AccountFormInitialValues } from '@/components/accounts/AccountForm';

const AccountForm = dynamic(
  () => import('@/components/accounts/AccountForm').then((m) => m.AccountForm),
  { ssr: false },
);

/** The slice of useFormModal state this modal needs to render and control itself. */
type AccountFormModalState = Pick<
  UseFormModalReturn<Account>,
  | 'showForm'
  | 'editingItem'
  | 'isEditing'
  | 'close'
  | 'modalProps'
  | 'setFormDirty'
  | 'unsavedChangesDialog'
  | 'formSubmitRef'
>;

interface AccountFormModalProps {
  /** State and handlers from a `useFormModal<Account>()` instance. */
  formModal: AccountFormModalState;
  /** Called after a successful create/update so the caller can refresh data. */
  onSaved: () => void;
  /**
   * Called after a successful create, once the form has closed, with the account
   * that was made, for a caller that goes on to use it (linking a bank account).
   * `onSaved` still runs first and takes no argument, so a refresh function that
   * has parameters of its own is never handed an account by mistake.
   */
  onCreated?: (created: Account) => void;
  /** Prefill for a new account (a bank account being linked); ignored on an edit. */
  initialValues?: AccountFormInitialValues;
}

/**
 * The shared account create/edit modal. Owns the create/update submission
 * (field cleaning, loan/mortgage sign handling, toasts) so every surface that
 * edits an account -- the Accounts page and the Transactions account widget --
 * reuses the exact same form and behaviour.
 */
export function AccountFormModal({
  formModal,
  onSaved,
  onCreated,
  initialValues,
}: AccountFormModalProps) {
  const t = useTranslations('accounts');
  const {
    showForm,
    editingItem,
    isEditing,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = formModal;

  const handleFormSubmit = async (data: any) => {
    try {
      const cleanedData = {
        ...data,
        openingBalance:
          data.openingBalance || data.openingBalance === 0
            ? data.openingBalance
            : undefined,
        creditLimit:
          data.creditLimit || data.creditLimit === 0
            ? data.creditLimit
            : undefined,
        interestRate:
          data.interestRate || data.interestRate === 0
            ? data.interestRate
            : undefined,
      };

      // LOAN/MORTGAGE store openingBalance as negative. The form shows the
      // absolute amount ("Loan Amount" / "Mortgage Amount"), so negate it when
      // saving an update. Backend handles negation on create for these types.
      // All other account types (including CREDIT_CARD, LINE_OF_CREDIT) let the
      // user type the sign directly, so no auto-negation is applied.
      const effectiveType = cleanedData.accountType || editingItem?.accountType;
      if (
        cleanedData.openingBalance != null &&
        cleanedData.openingBalance > 0 &&
        (effectiveType === 'LOAN' || effectiveType === 'MORTGAGE') &&
        editingItem
      ) {
        cleanedData.openingBalance = -cleanedData.openingBalance;
      }

      // When editing, a cleared optional field must reach the backend as null
      // so the stored value is overwritten. Left as '' or undefined it would be
      // stripped by the cleanup below and the field would silently keep its old
      // value (e.g. removing a description would not save). Only always-rendered
      // plain text inputs belong here, where an empty submitted value can only
      // mean the user emptied the field. institutionId must NOT be inferred
      // from absence: the form submits an explicit null when the user clears
      // the institution combobox, and force-nulling a merely absent value
      // wiped the institution from investment cash accounts on unrelated
      // edits (issue #806).
      if (editingItem) {
        const clearableFields = ['description', 'accountNumber'] as const;
        for (const key of clearableFields) {
          if (
            (cleanedData[key] === '' || cleanedData[key] === undefined) &&
            editingItem[key]
          ) {
            cleanedData[key] = null;
          }
        }

        // Foreign-transaction fee: an emptied value on edit must reach the
        // backend as null so a previously configured fee is cleared rather than
        // silently retained (null survives the strip-empties cleanup below).
        const feePercentEmpty =
          cleanedData.fxFeePercent === undefined ||
          cleanedData.fxFeePercent === '' ||
          (typeof cleanedData.fxFeePercent === 'number' &&
            isNaN(cleanedData.fxFeePercent));
        if (feePercentEmpty && editingItem.fxFeePercent != null) {
          cleanedData.fxFeePercent = null;
        }
      }

      Object.keys(cleanedData).forEach((key) => {
        if (
          cleanedData[key] === undefined ||
          cleanedData[key] === '' ||
          (typeof cleanedData[key] === 'number' && isNaN(cleanedData[key]))
        ) {
          delete cleanedData[key];
        }
      });

      // A linked pair is one account with two ledgers, so the form can carry
      // edits to both. The cash fields are present only when the user touched
      // that section; the account's own update goes first, since the rename it
      // may carry is what the server propagates to the partner.
      const {
        cashAccountId,
        cashOpeningBalance,
        cashDescription,
        cashAccountNumber,
        ...accountData
      } = cleanedData;

      let created: Account | undefined;
      if (editingItem) {
        await accountsApi.update(editingItem.id, accountData);
        if (cashAccountId) {
          await accountsApi.update(cashAccountId, {
            openingBalance: cashOpeningBalance,
            description: cashDescription ?? null,
            accountNumber: cashAccountNumber ?? null,
          });
        }
        toast.success(t('toast.updateSuccess'));
      } else {
        created = await accountsApi.create(accountData);
        toast.success(t('toast.createSuccess'));
      }
      close();
      onSaved();
      if (created) onCreated?.(created);
    } catch (error) {
      showErrorToast(
        error,
        `Failed to ${editingItem ? 'update' : 'create'} account`,
      );
      throw error;
    }
  };

  return (
    <>
      <Modal
        isOpen={showForm}
        onClose={close}
        {...modalProps}
        maxWidth="2xl"
        className="p-6"
      >
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {isEditing ? t('page.editAccountModal') : t('page.newAccountModal')}
        </h2>
        <AccountForm
          account={editingItem}
          initialValues={initialValues}
          onSubmit={handleFormSubmit}
          onCancel={close}
          onDirtyChange={setFormDirty}
          submitRef={formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...unsavedChangesDialog} />
    </>
  );
}
