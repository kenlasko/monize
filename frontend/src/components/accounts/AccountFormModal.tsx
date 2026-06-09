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
}

/**
 * The shared account create/edit modal. Owns the create/update submission
 * (field cleaning, loan/mortgage sign handling, toasts) so every surface that
 * edits an account -- the Accounts page and the Transactions account widget --
 * reuses the exact same form and behaviour.
 */
export function AccountFormModal({ formModal, onSaved }: AccountFormModalProps) {
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
      // value (e.g. removing a description or institution would not save).
      if (editingItem) {
        const clearableFields = [
          'description',
          'accountNumber',
          'institutionId',
        ] as const;
        for (const key of clearableFields) {
          if (
            (cleanedData[key] === '' || cleanedData[key] === undefined) &&
            editingItem[key]
          ) {
            cleanedData[key] = null;
          }
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

      if (editingItem) {
        await accountsApi.update(editingItem.id, cleanedData);
        toast.success(t('toast.updateSuccess'));
      } else {
        await accountsApi.create(cleanedData);
        toast.success(t('toast.createSuccess'));
      }
      close();
      onSaved();
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
