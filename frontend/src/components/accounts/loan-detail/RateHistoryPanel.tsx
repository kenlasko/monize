'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { LoanRateChange } from '@/types/loan-rate-change';
import { Account } from '@/types/account';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type PaymentMode = 'keep' | 'set' | 'recalculate';

interface RateHistoryPanelProps {
  account: Account;
  rateChanges: LoanRateChange[];
  onChanged: () => void;
}

interface FormState {
  effectiveDate: string;
  annualRate: string;
  paymentMode: PaymentMode;
  newPaymentAmount: string;
  note: string;
}

const emptyForm = (): FormState => ({
  effectiveDate: '',
  annualRate: '',
  paymentMode: 'keep',
  newPaymentAmount: '',
  note: '',
});

/**
 * The account's interest-rate history: record rate changes (variable-rate
 * resets, term renewals/refinances), edit or delete them, and detect past
 * changes from the payment history. When a rate changes the payment can be
 * kept (splits re-shift, payoff moves), set explicitly, or recalculated to
 * hold the remaining amortization (mortgages).
 */
export function RateHistoryPanel({ account, rateChanges, onChanged }: RateHistoryPanelProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();

  const [formModal, setFormModal] = useState<
    { mode: 'add' } | { mode: 'edit'; change: LoanRateChange } | null
  >(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [changeToDelete, setChangeToDelete] = useState<LoanRateChange | null>(null);
  const [showDetectConfirm, setShowDetectConfirm] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);

  const isMortgage = account.accountType === 'MORTGAGE';
  const sortedChanges = [...rateChanges].sort((a, b) =>
    b.effectiveDate.localeCompare(a.effectiveDate),
  );

  const openAdd = () => {
    setForm(emptyForm());
    setFormModal({ mode: 'add' });
  };

  const openEdit = (change: LoanRateChange) => {
    setForm({
      effectiveDate: change.effectiveDate,
      annualRate: String(change.annualRate),
      paymentMode: change.newPaymentAmount != null ? 'set' : 'keep',
      newPaymentAmount: change.newPaymentAmount != null ? String(change.newPaymentAmount) : '',
      note: change.note ?? '',
    });
    setFormModal({ mode: 'edit', change });
  };

  const parsedRate = Number.parseFloat(form.annualRate);
  const parsedPayment = Number.parseFloat(form.newPaymentAmount);
  const isFormValid =
    form.effectiveDate.length > 0 &&
    Number.isFinite(parsedRate) &&
    parsedRate >= 0 &&
    parsedRate <= 100 &&
    (form.paymentMode !== 'set' || (Number.isFinite(parsedPayment) && parsedPayment > 0));

  const submitForm = async () => {
    if (!formModal || !isFormValid) return;
    setIsSubmitting(true);
    try {
      const note = form.note.trim();
      if (formModal.mode === 'add') {
        await loanRateChangesApi.create(account.id, {
          effectiveDate: form.effectiveDate,
          annualRate: parsedRate,
          newPaymentAmount: form.paymentMode === 'set' ? parsedPayment : null,
          recalculatePayment: form.paymentMode === 'recalculate',
          note: note || null,
        });
        toast.success(t('loanDetail.rateHistory.addedToast'));
      } else {
        await loanRateChangesApi.update(account.id, formModal.change.id, {
          effectiveDate: form.effectiveDate,
          annualRate: parsedRate,
          newPaymentAmount: form.paymentMode === 'set' ? parsedPayment : null,
          note: note || null,
        });
        toast.success(t('loanDetail.rateHistory.updatedToast'));
      }
      setFormModal(null);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.saveFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!changeToDelete) return;
    try {
      await loanRateChangesApi.delete(account.id, changeToDelete.id);
      toast.success(t('loanDetail.rateHistory.deletedToast'));
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.deleteFailed')));
    } finally {
      setChangeToDelete(null);
    }
  };

  const runDetect = async () => {
    setShowDetectConfirm(false);
    setIsDetecting(true);
    try {
      const result = await loanRateChangesApi.detect(account.id);
      toast.success(
        t('loanDetail.rateHistory.detectedToast', { count: result.created.length }),
      );
      for (const warning of result.warnings) {
        toast(warning, { icon: '⚠️' });
      }
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.rateHistory.detectFailed')));
    } finally {
      setIsDetecting(false);
    }
  };

  const sourceBadge = (change: LoanRateChange) => {
    if (change.source === 'inferred') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {t('loanDetail.rateHistory.badgeInferred')}
        </span>
      );
    }
    if (change.source === 'initial') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          {t('loanDetail.rateHistory.badgeInitial')}
        </span>
      );
    }
    return null;
  };

  const paymentLabel = (change: LoanRateChange) =>
    change.newPaymentAmount != null
      ? formatCurrency(change.newPaymentAmount, account.currencyCode)
      : t('loanDetail.rateHistory.paymentUnchanged');

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('loanDetail.rateHistory.title')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.rateHistory.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDetectConfirm(true)}
            isLoading={isDetecting}
          >
            {t('loanDetail.rateHistory.detect')}
          </Button>
          <Button size="sm" onClick={openAdd}>
            {t('loanDetail.rateHistory.add')}
          </Button>
        </div>
      </div>

      {sortedChanges.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.rateHistory.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {sortedChanges.map((change) => (
            <li
              key={change.id}
              className="py-2 flex flex-wrap items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  <span>{format(parseISO(change.effectiveDate), 'MMM d, yyyy')}</span>
                  <span className="text-blue-600 dark:text-blue-400">
                    {t('loanDetail.rateHistory.rateValue', { rate: change.annualRate })}
                  </span>
                  {sourceBadge(change)}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {t('loanDetail.rateHistory.paymentSummary', {
                    payment: paymentLabel(change),
                  })}
                  {change.note ? ` — ${change.note}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => openEdit(change)}>
                  {t('loanDetail.rateHistory.edit')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setChangeToDelete(change)}>
                  {t('loanDetail.rateHistory.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal isOpen={formModal !== null} onClose={() => setFormModal(null)} maxWidth="md">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {formModal?.mode === 'edit'
              ? t('loanDetail.rateHistory.editTitle')
              : t('loanDetail.rateHistory.addTitle')}
          </h3>
          <div className="space-y-4">
            <Input
              type="date"
              label={t('loanDetail.rateHistory.effectiveDateLabel')}
              value={form.effectiveDate}
              onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
            />
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              label={t('loanDetail.rateHistory.rateLabel')}
              value={form.annualRate}
              onChange={(e) => setForm((f) => ({ ...f, annualRate: e.target.value }))}
            />

            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('loanDetail.rateHistory.paymentModeLabel')}
              </legend>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="paymentMode"
                    checked={form.paymentMode === 'keep'}
                    onChange={() => setForm((f) => ({ ...f, paymentMode: 'keep' }))}
                  />
                  {t('loanDetail.rateHistory.paymentModeKeep')}
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="radio"
                    name="paymentMode"
                    checked={form.paymentMode === 'set'}
                    onChange={() => setForm((f) => ({ ...f, paymentMode: 'set' }))}
                  />
                  {t('loanDetail.rateHistory.paymentModeSet')}
                </label>
                {isMortgage && formModal?.mode === 'add' && (
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="paymentMode"
                      checked={form.paymentMode === 'recalculate'}
                      onChange={() => setForm((f) => ({ ...f, paymentMode: 'recalculate' }))}
                    />
                    {t('loanDetail.rateHistory.paymentModeRecalculate')}
                  </label>
                )}
              </div>
            </fieldset>

            {form.paymentMode === 'set' && (
              <Input
                type="number"
                step="0.01"
                min="0.01"
                label={t('loanDetail.rateHistory.newPaymentLabel')}
                value={form.newPaymentAmount}
                onChange={(e) =>
                  setForm((f) => ({ ...f, newPaymentAmount: e.target.value }))
                }
              />
            )}

            <Input
              label={t('loanDetail.rateHistory.noteLabel')}
              value={form.note}
              maxLength={500}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setFormModal(null)}>
              {t('loanDetail.rateHistory.cancel')}
            </Button>
            <Button onClick={submitForm} disabled={!isFormValid} isLoading={isSubmitting}>
              {t('loanDetail.rateHistory.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={changeToDelete !== null}
        title={t('loanDetail.rateHistory.deleteTitle')}
        message={t('loanDetail.rateHistory.deleteMessage', {
          date: changeToDelete
            ? format(parseISO(changeToDelete.effectiveDate), 'MMM d, yyyy')
            : '',
        })}
        confirmLabel={t('loanDetail.rateHistory.delete')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setChangeToDelete(null)}
      />

      <ConfirmDialog
        isOpen={showDetectConfirm}
        title={t('loanDetail.rateHistory.detectTitle')}
        message={t('loanDetail.rateHistory.detectMessage')}
        confirmLabel={t('loanDetail.rateHistory.detect')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        onConfirm={runDetect}
        onCancel={() => setShowDetectConfirm(false)}
      />
    </div>
  );
}
