'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Payee } from '@/types/payee';

interface ReactivatePayeeDialogProps {
  isOpen: boolean;
  payee: Payee | null;
  onReactivate: () => void;
  /** "Keep Inactive". */
  onCancel: () => void;
  /**
   * Closing the dialog without answering (Escape, the backdrop), where that
   * must differ from "Keep Inactive": Quick Add's save goes on under the typed
   * name on the one and stops on the other. Defaults to `onCancel`.
   */
  onDismiss?: () => void;
  isReactivating?: boolean;
}

export function ReactivatePayeeDialog({
  isOpen,
  payee,
  onReactivate,
  onCancel,
  onDismiss,
  isReactivating = false,
}: ReactivatePayeeDialogProps) {
  const t = useTranslations('payees');

  if (!payee) return null;

  return (
    // A confirmation, but not ConfirmDialog: its buttons must stay disabled
    // while the reactivation is in flight (a second click would add the payee
    // to TransactionForm's list twice), which ConfirmDialog cannot do. The
    // paragraph is the question being confirmed, not help text.
    <Modal
      isOpen={isOpen}
      onClose={onDismiss ?? onCancel}
      maxWidth="sm"
      className="p-6"
      title={t('reactivate.title')}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('reactivate.message', { name: payee.name })}
      </p>
      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onCancel} disabled={isReactivating}>
          {t('reactivate.keepInactiveButton')}
        </Button>
        <Button onClick={onReactivate} disabled={isReactivating}>
          {isReactivating ? t('reactivate.reactivating') : t('reactivate.reactivateButton')}
        </Button>
      </div>
    </Modal>
  );
}
