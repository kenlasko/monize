'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDateFormat } from '@/hooks/useDateFormat';
import { LoanRateEditing } from './useLoanRateEditing';

interface LoanRateControlsProps {
  editing: LoanRateEditing;
}

/**
 * The Loan Schedule's rate-timeline controls: header buttons to detect rate
 * changes from history or add one manually, plus the add/edit modal, the delete
 * and detect confirmations, and the scheduled-payment permission prompt. All
 * behaviour lives in `useLoanRateEditing`; this component only renders it.
 */
export function LoanRateControls({ editing }: LoanRateControlsProps) {
  const t = useTranslations('accounts');
  const { formatDate } = useDateFormat();
  const { form, setForm, formModal, isMortgage } = editing;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={editing.openDetect}
        isLoading={editing.isDetecting}
      >
        {t('loanDetail.rateHistory.detect')}
      </Button>
      <Button size="sm" onClick={editing.openAdd}>
        {t('loanDetail.rateHistory.add')}
      </Button>

      <Modal isOpen={formModal !== null} onClose={editing.closeForm} maxWidth="md">
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
              onChange={(e) =>
                setForm((f) => ({ ...f, effectiveDate: e.target.value }))
              }
            />
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              label={t('loanDetail.rateHistory.rateLabel')}
              value={form.annualRate}
              onChange={(e) =>
                setForm((f) => ({ ...f, annualRate: e.target.value }))
              }
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
                      onChange={() =>
                        setForm((f) => ({ ...f, paymentMode: 'recalculate' }))
                      }
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
            <Button variant="outline" onClick={editing.closeForm}>
              {t('loanDetail.rateHistory.cancel')}
            </Button>
            <Button
              onClick={editing.submitForm}
              disabled={!editing.isFormValid}
              isLoading={editing.isSubmitting}
            >
              {t('loanDetail.rateHistory.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={editing.changeToDelete !== null}
        title={t('loanDetail.rateHistory.deleteTitle')}
        message={t('loanDetail.rateHistory.deleteMessage', {
          date: editing.changeToDelete
            ? formatDate(editing.changeToDelete.effectiveDate)
            : '',
        })}
        confirmLabel={t('loanDetail.rateHistory.delete')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        variant="danger"
        onConfirm={editing.confirmDelete}
        onCancel={editing.cancelDelete}
      />

      <ConfirmDialog
        isOpen={editing.showDetectConfirm}
        title={t('loanDetail.rateHistory.detectTitle')}
        message={t('loanDetail.rateHistory.detectMessage')}
        confirmLabel={t('loanDetail.rateHistory.detect')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        onConfirm={editing.runDetect}
        onCancel={editing.cancelDetect}
      />

      <ConfirmDialog
        isOpen={editing.scheduledPreview !== null}
        variant="info"
        title={t('loanDetail.rateHistory.scheduledUpdateTitle')}
        message={editing.scheduledUpdateMessage}
        confirmLabel={t('loanDetail.rateHistory.scheduledUpdateConfirm')}
        cancelLabel={t('loanDetail.rateHistory.scheduledUpdateSkip')}
        onConfirm={editing.applyScheduledPayment}
        onCancel={editing.skipScheduledPayment}
      />
    </div>
  );
}
