'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { LoanRateChange, ScheduledPaymentPreview } from '@/types/loan-rate-change';
import { Account } from '@/types/account';
import { getErrorMessage } from '@/lib/errors';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { invalidateBalanceCaches, invalidateCache } from '@/lib/apiCache';

export type RatePaymentMode = 'keep' | 'set' | 'recalculate';

export interface RateFormState {
  effectiveDate: string;
  annualRate: number | undefined;
  paymentMode: RatePaymentMode;
  newPaymentAmount: number | undefined;
  note: string;
}

const emptyForm = (): RateFormState => ({
  effectiveDate: '',
  annualRate: undefined,
  paymentMode: 'keep',
  newPaymentAmount: undefined,
  note: '',
});

/** Cents-level tolerance for "did the payment actually change". */
const PAYMENT_UNCHANGED_TOLERANCE = 0.005;

interface ScheduledUpdateFormatters {
  t: (key: string, values?: Record<string, string | number>) => string;
  formatDate: (date: Date | string) => string;
  formatCurrency: (value: number, currencyCode?: string) => string;
}

/**
 * The scheduled-payment confirmation's message: the next installment with
 * its due date (unchanged, or before/after when the sync would change it),
 * and, for each later payment the timeline states, from which due date the
 * bill becomes that payment (spec `scheduled-loan-installment-pricing.md`
 * section 7.5). Pure so it can be unit tested without rendering the hook.
 */
export function buildScheduledUpdateMessage(
  preview: ScheduledPaymentPreview | null,
  { t, formatDate, formatCurrency }: ScheduledUpdateFormatters,
): string {
  if (!preview) return '';

  const name =
    preview.scheduledTransactionName || t('loanDetail.rateHistory.scheduledUpdateDefaultName');
  const date = formatDate(preview.dueDate);
  const payment = formatCurrency(preview.proposedPaymentAmount, preview.currencyCode);
  const unchanged =
    preview.currentPaymentAmount != null &&
    Math.abs(preview.currentPaymentAmount - preview.proposedPaymentAmount) <
      PAYMENT_UNCHANGED_TOLERANCE;

  let nextPaymentLine: string;
  if (unchanged) {
    nextPaymentLine = t('loanDetail.rateHistory.scheduledUpdateNextPaymentUnchanged', {
      name,
      date,
      payment,
    });
  } else {
    const principal = formatCurrency(preview.proposedPrincipal, preview.currencyCode);
    const interest = formatCurrency(preview.proposedInterest, preview.currencyCode);
    nextPaymentLine =
      preview.currentPaymentAmount != null
        ? t('loanDetail.rateHistory.scheduledUpdateNextPaymentChanged', {
            name,
            date,
            before: formatCurrency(preview.currentPaymentAmount, preview.currencyCode),
            after: payment,
            principal,
            interest,
          })
        : t('loanDetail.rateHistory.scheduledUpdateNextPaymentNew', {
            name,
            date,
            payment,
            principal,
            interest,
          });
  }

  const upcomingLines = preview.upcomingPaymentChanges.map((change) =>
    t('loanDetail.rateHistory.scheduledUpdateUpcomingChange', {
      date: formatDate(change.dueDate),
      amount: formatCurrency(change.paymentAmount, preview.currencyCode),
    }),
  );
  return [nextPaymentLine, ...upcomingLines].join(' ');
}

/**
 * The rate-timeline editing behaviour shared by the Loan Schedule's rate cells
 * (each opens the Add form pre-filled with its date and rate), the rate
 * controls (Add / per-change edit + delete), and the Rate History panel: the
 * create/update/delete mutations, the scheduled-payment "ask permission"
 * prompt, and detect-from-history. Kept out of the components so the schedule,
 * the controls, and the panel all drive one instance.
 */
export function useLoanRateEditing(account: Account, onChanged: () => void) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const [formModal, setFormModal] = useState<
    { mode: 'add' } | { mode: 'edit'; change: LoanRateChange } | null
  >(null);
  const [form, setForm] = useState<RateFormState>(emptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [changeToDelete, setChangeToDelete] = useState<LoanRateChange | null>(null);
  const [showDetectConfirm, setShowDetectConfirm] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [scheduledPreview, setScheduledPreview] =
    useState<ScheduledPaymentPreview | null>(null);

  const isMortgage = account.accountType === 'MORTGAGE';

  const openAdd = () => {
    setForm(emptyForm());
    setFormModal({ mode: 'add' });
  };

  const openEdit = (change: LoanRateChange) => {
    setForm({
      effectiveDate: change.effectiveDate,
      annualRate: Number(change.annualRate),
      paymentMode: change.newPaymentAmount != null ? 'set' : 'keep',
      newPaymentAmount:
        change.newPaymentAmount != null ? Number(change.newPaymentAmount) : undefined,
      note: change.note ?? '',
    });
    setFormModal({ mode: 'edit', change });
  };

  /**
   * Open the Add form pre-filled with a date and rate -- used from a schedule
   * row's rate cell so the user can record a rate change at that point with the
   * values already in hand. Payment mode defaults to "keep".
   */
  const openAddWith = (effectiveDate: string, annualRate: number) => {
    setForm({
      effectiveDate: effectiveDate.split('T')[0],
      annualRate,
      paymentMode: 'keep',
      newPaymentAmount: undefined,
      note: '',
    });
    setFormModal({ mode: 'add' });
  };

  const closeForm = () => setFormModal(null);

  const parsedRate = form.annualRate ?? NaN;
  const parsedPayment = form.newPaymentAmount ?? NaN;
  const isFormValid =
    form.effectiveDate.length > 0 &&
    Number.isFinite(parsedRate) &&
    parsedRate >= 0 &&
    parsedRate <= 100 &&
    (form.paymentMode !== 'set' ||
      (Number.isFinite(parsedPayment) && parsedPayment > 0));

  const submitForm = async () => {
    if (!formModal || !isFormValid) return;
    setIsSubmitting(true);
    try {
      const note = form.note.trim();
      if (formModal.mode === 'add') {
        const result = await loanRateChangesApi.create(account.id, {
          effectiveDate: form.effectiveDate,
          annualRate: parsedRate,
          newPaymentAmount: form.paymentMode === 'set' ? parsedPayment : null,
          recalculatePayment: form.paymentMode === 'recalculate',
          note: note || null,
        });
        toast.success(t('loanDetail.rateHistory.addedToast'));
        setFormModal(null);
        onChanged();
        // A linked scheduled bill payment can be resynced to the new rate, but
        // only with the user's permission -- surface the pending change.
        if (result.scheduledPaymentPreview) {
          setScheduledPreview(result.scheduledPaymentPreview);
        }
        return;
      }
      const updated = await loanRateChangesApi.update(account.id, formModal.change.id, {
        effectiveDate: form.effectiveDate,
        annualRate: parsedRate,
        newPaymentAmount: form.paymentMode === 'set' ? parsedPayment : null,
        note: note || null,
      });
      toast.success(t('loanDetail.rateHistory.updatedToast'));
      setFormModal(null);
      onChanged();
      // Editing a rate change can also realign the linked scheduled bill, but
      // only with the user's permission -- surface the pending change.
      if (updated.scheduledPaymentPreview) {
        setScheduledPreview(updated.scheduledPaymentPreview);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.saveFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };


  const requestDelete = (change: LoanRateChange) => setChangeToDelete(change);
  const cancelDelete = () => setChangeToDelete(null);
  const confirmDelete = async () => {
    if (!changeToDelete) return;
    try {
      const result = await loanRateChangesApi.delete(account.id, changeToDelete.id);
      toast.success(t('loanDetail.rateHistory.deletedToast'));
      onChanged();
      // Deleting a rate change can also realign the linked scheduled bill to
      // what the remaining timeline calls for -- surface the pending change.
      if (result.scheduledPaymentPreview) {
        setScheduledPreview(result.scheduledPaymentPreview);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.deleteFailed')));
    } finally {
      setChangeToDelete(null);
    }
  };

  const applyScheduledPayment = async () => {
    if (!scheduledPreview) return;
    setScheduledPreview(null);
    try {
      await loanRateChangesApi.applyScheduledPayment(account.id);
      // The rewritten template moves the bill's next payment and the
      // balances it projects, including the ones other screens cache.
      invalidateBalanceCaches();
      invalidateCache('scheduled:');
      toast.success(t('loanDetail.rateHistory.scheduledUpdateAppliedToast'));
      onChanged();
    } catch (err) {
      toast.error(
        getErrorMessage(err, t('loanDetail.rateHistory.scheduledUpdateFailed')),
      );
    }
  };

  const skipScheduledPayment = () => {
    setScheduledPreview(null);
    toast(t('loanDetail.rateHistory.scheduledUpdateSkippedToast'), { icon: 'ℹ️' });
  };

  // Detect rate changes from the payment history (backend segmentation). It is
  // non-destructive: only previously *inferred* rows are replaced; manual and
  // initial rows, and the account's own rate/payment, are left untouched.
  const openDetect = () => setShowDetectConfirm(true);
  const cancelDetect = () => setShowDetectConfirm(false);
  const runDetect = async () => {
    setShowDetectConfirm(false);
    setIsDetecting(true);
    try {
      const result = await loanRateChangesApi.detect(account.id);
      toast.success(
        t('loanDetail.rateHistory.detectedToast', { count: result.created.length }),
      );
      for (const warning of result.warnings) toast(warning, { icon: '⚠️' });
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.detectFailed')));
    } finally {
      setIsDetecting(false);
    }
  };

  const scheduledUpdateMessage = buildScheduledUpdateMessage(scheduledPreview, {
    t,
    formatDate,
    formatCurrency,
  });

  return {
    isMortgage,
    currencySymbol: getCurrencySymbol(account.currencyCode),
    // header actions
    openAdd,
    // per-change actions
    openEdit,
    openAddWith,
    requestDelete,
    // add/edit form
    formModal,
    form,
    setForm,
    isSubmitting,
    isFormValid,
    submitForm,
    closeForm,
    // delete confirm
    changeToDelete,
    confirmDelete,
    cancelDelete,
    // detect from history
    openDetect,
    cancelDetect,
    showDetectConfirm,
    isDetecting,
    runDetect,
    // scheduled-payment prompt
    scheduledPreview,
    scheduledUpdateMessage,
    applyScheduledPayment,
    skipScheduledPayment,
  };
}

export type LoanRateEditing = ReturnType<typeof useLoanRateEditing>;
