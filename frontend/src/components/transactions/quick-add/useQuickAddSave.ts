'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import type { TransactionSubmitMode } from '@/hooks/useTransactionSubmitMode';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { LAST_TRANSACTION_DATE_KEY, rememberTransactionDate } from '@/lib/lastTransactionDate';
import { createLogger } from '@/lib/logger';
import { createPayeeFromName } from '@/lib/payee-create';
import { payeesApi } from '@/lib/payees';
import { transactionsApi } from '@/lib/transactions';
import type { Payee } from '@/types/payee';
import type { QuickAddInterpretation } from '@/types/quick-add';
import { buildQuickAddSave, withSavedPayee, type QuickAddSaveRequest } from './quick-add-entry';

const logger = createLogger('QuickAddSave');

export interface QuickAddSaveCallbacks {
  /** The row was written; `mode` says whether to close or clear for the next line. */
  onSaved: (mode: TransactionSubmitMode) => void;
  /**
   * The save made (or brought back) the line's payee and then failed to write
   * the row. The payee exists now, so the host pins it: asking the server to
   * make it again would be refused as a duplicate name.
   */
  onPayeeKept: (payee: Payee) => void;
}

/** A save waiting on the reader: an inactive payee has the line's payee name. */
interface PendingReactivation {
  payee: Payee;
  request: QuickAddSaveRequest;
  mode: TransactionSubmitMode;
}

/**
 * Quick Add's save (`docs/future-plans/quick-add.md`, "Saving"): the create
 * call New Transaction makes for the same fields, then what its create does
 * after it. A payee the line named but nobody has yet is created first,
 * exactly as the full form's payee field does it (`createPayeeFromName`):
 * an inactive payee of that name is offered back through
 * `ReactivatePayeeDialog`, and the save goes on from the reader's answer. The
 * created payee is left to the server's own background contact lookup, since
 * Quick Add has no room to ask about what one finds.
 */
export function useQuickAddSave(callbacks: QuickAddSaveCallbacks) {
  const t = useTranslations('transactions');
  const [isSaving, setIsSaving] = useState(false);
  // Set on the key or click, before the request: `isSaving` lands a render
  // later and cannot stop a second Enter from writing the row twice. Held
  // while the reader is asked about an inactive payee, too.
  const inFlight = useRef(false);
  const [reactivation, setReactivation] = useState<PendingReactivation | null>(null);
  const [isReactivating, setIsReactivating] = useState(false);
  const latest = useRef(callbacks);
  useEffect(() => {
    latest.current = callbacks;
  });

  const begin = () => {
    inFlight.current = true;
    setIsSaving(true);
  };
  const end = () => {
    inFlight.current = false;
    setIsSaving(false);
  };

  /** Writes the row; true once it is written. */
  const commit = async (request: QuickAddSaveRequest, mode: TransactionSubmitMode): Promise<boolean> => {
    try {
      if (request.kind === 'transfer') {
        await transactionsApi.createTransfer(request.body);
        toast.success(t('form.toasts.transferCreated'));
      } else {
        await transactionsApi.create(request.body);
        toast.success(t('form.toasts.transactionCreated'));
      }
      // The client modules drop these too; said here as well, because a save
      // that moves money is not finished until the balances are dropped.
      invalidateBalanceCaches();
      // The next entry opens on this one's date, as after New Transaction.
      rememberTransactionDate(LAST_TRANSACTION_DATE_KEY, request.body.transactionDate);
      latest.current.onSaved(mode);
      return true;
    } catch (error) {
      logger.error('Quick Add save failed:', error);
      toast.error(getErrorMessage(error, t('form.toasts.saveFailed')));
      return false;
    }
  };

  /** Writes the row linked to `payee`, keeping the payee if the row is refused. */
  const commitWithPayee = async (
    request: QuickAddSaveRequest,
    mode: TransactionSubmitMode,
    payee: Payee,
  ) => {
    if (!(await commit(withSavedPayee(request, payee), mode))) latest.current.onPayeeKept(payee);
  };

  /** Saves `reading`, which the server says nothing blocks. */
  const save = async (reading: QuickAddInterpretation, mode: TransactionSubmitMode) => {
    if (inFlight.current) return;
    const request = buildQuickAddSave(reading);
    if (!request) return;
    begin();
    let askingReader = false;
    try {
      const payee = reading.payee.value;
      if (payee !== null && payee.id === null && payee.name.trim()) {
        let outcome;
        try {
          outcome = await createPayeeFromName(payee.name);
        } catch (error) {
          logger.error('Quick Add payee create failed:', error);
          toast.error(getErrorMessage(error, t('form.toasts.payeeCreateFailed')));
          return;
        }
        if (outcome?.kind === 'inactive') {
          askingReader = true;
          setReactivation({ payee: outcome.payee, request, mode });
          return;
        }
        if (outcome) {
          toast.success(t('form.toasts.payeeCreated', { name: payee.name.trim() }));
          await commitWithPayee(request, mode, outcome.payee);
          return;
        }
      }
      await commit(request, mode);
    } finally {
      if (!askingReader) end();
    }
  };

  /** "Reactivate": bring the payee back and save the row linked to it. */
  const reactivate = async () => {
    if (!reactivation) return;
    setIsReactivating(true);
    let reactivated: Payee;
    try {
      reactivated = await payeesApi.reactivatePayee(reactivation.payee.id);
    } catch (error) {
      // The question stays open, as in the full form.
      logger.error('Failed to reactivate payee:', error);
      toast.error(getErrorMessage(error, t('form.toasts.payeeReactivateFailed')));
      setIsReactivating(false);
      return;
    }
    toast.success(t('form.toasts.payeeReactivated', { name: reactivated.name }));
    setReactivation(null);
    setIsReactivating(false);
    try {
      await commitWithPayee(reactivation.request, reactivation.mode, reactivated);
    } finally {
      end();
    }
  };

  /** "Keep Inactive": the name stays text on the row with no payee, as in the full form. */
  const keepInactive = async () => {
    if (!reactivation) return;
    setReactivation(null);
    try {
      await commit(reactivation.request, reactivation.mode);
    } finally {
      end();
    }
  };

  /** Closed without an answer: nothing is saved. */
  const dismiss = () => {
    setReactivation(null);
    end();
  };

  return {
    save,
    isSaving,
    /** Props for the `ReactivatePayeeDialog` the host draws beside its own. */
    reactivationDialog: {
      isOpen: reactivation !== null,
      payee: reactivation?.payee ?? null,
      isReactivating,
      onReactivate: () => void reactivate(),
      onCancel: () => void keepInactive(),
      onDismiss: dismiss,
    },
  };
}
