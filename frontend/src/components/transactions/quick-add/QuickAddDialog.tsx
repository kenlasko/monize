'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormActions } from '@/components/ui/FormActions';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import type { UseFormModalReturn } from '@/hooks/useFormModal';
import {
  TRANSACTION_SUBMIT_MODE_KEY,
  useTransactionSubmitMode,
  type TransactionSubmitMode,
} from '@/hooks/useTransactionSubmitMode';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { QUICK_ADD_TEXT_MAX_LENGTH } from '@/lib/quick-add';
import { transactionsApi } from '@/lib/transactions';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import type { QuickAddPins } from '@/types/quick-add';
import type { TransactionFormDraft } from '../transaction-form-draft';
import { QuickAddChips } from './QuickAddChips';
import { QuickAddSummary } from './QuickAddSummary';
import { hasPins, mergePins, type QuickAddChipField } from './quick-add-chips';
import { buildQuickAddDraft, buildQuickAddSave } from './quick-add-entry';
import { useQuickAddInterpretation } from './useQuickAddInterpretation';

const logger = createLogger('QuickAddDialog');

type QuickAddFormModal = Pick<
  UseFormModalReturn<unknown>,
  'close' | 'modalProps' | 'setFormDirty' | 'unsavedChangesDialog' | 'formSubmitRef'
>;

export interface QuickAddDialogProps {
  /** The page's `useFormModal()` for this dialog; mounted only while open. */
  formModal: QuickAddFormModal;
  /** A line typed elsewhere (the command palette), read again here. */
  initialText?: string;
  /** The register's single filtered account, sent as the reading's context. */
  contextAccountId?: string;
  accounts: Account[];
  payees: Payee[];
  categories: Category[];
  /** A row was written: the host refreshes what it shows behind. */
  onSaved: () => void;
  /** Hand the entry to New Transaction; the host closes this dialog first. */
  onFullForm: (draft: TransactionFormDraft) => void;
}

/**
 * Quick Add (`docs/future-plans/quick-add.md`, "The dialog"): one line read by
 * the server as a payment, deposit or transfer, shown as chips the reader can
 * change, and saved through the same create calls, with the same body, as New
 * Transaction. Enter saves when nothing blocks it; Shift+Enter saves and
 * clears the line for the next one.
 */
export function QuickAddDialog({
  formModal,
  initialText = '',
  contextAccountId,
  accounts,
  payees,
  categories,
  onSaved,
  onFullForm,
}: QuickAddDialogProps) {
  const t = useTranslations('transactions');
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const today = useFinancialToday();
  const [text, setText] = useState(initialText);
  const [pins, setPins] = useState<QuickAddPins>({});
  const [editing, setEditing] = useState<QuickAddChipField | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Set on the key or click, before the request: `isSaving` lands a render
  // later and cannot stop a second Enter from writing the row twice.
  const saveInFlight = useRef(false);
  const [submitMode, setSubmitMode] = useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY);

  const reading = useQuickAddInterpretation({ text, pins, today, contextAccountId });
  const current = reading.interpretation;
  const canSave = !!current && current.blockers.length === 0 && !isSaving;

  useFormDirtyNotify(text.trim() !== '' || hasPins(pins), formModal.setFormDirty);

  const save = async (mode: TransactionSubmitMode) => {
    if (!current || saveInFlight.current) return;
    const request = buildQuickAddSave(current);
    if (!request) return;
    saveInFlight.current = true;
    setIsSaving(true);
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
      onSaved();
      if (mode === 'new') {
        setText('');
        setPins({});
        setEditing(null);
        inputRef.current?.focus();
      } else {
        formModal.setFormDirty(false);
        formModal.close();
      }
    } catch (error) {
      logger.error('Quick Add save failed:', error);
      toast.error(getErrorMessage(error, t('form.toasts.saveFailed')));
    } finally {
      saveInFlight.current = false;
      setIsSaving(false);
    }
  };

  // Save from the unsaved-changes dialog saves and closes, as New Transaction's does.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const submitRef = formModal.formSubmitRef;
    submitRef.current = () => void saveRef.current('close');
    return () => {
      submitRef.current = null;
    };
  }, [formModal.formSubmitRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSave) void save(event.shiftKey ? 'new' : submitMode);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSave) void save(submitMode);
  };

  const handleFullForm = () => onFullForm(buildQuickAddDraft(current, pins));

  const shown = reading.shown;

  return (
    <>
      <Modal
        isOpen
        onClose={formModal.close}
        {...formModal.modalProps}
        maxWidth="2xl"
        className="p-6"
        title={t('quickAdd.title')}
        description={t('quickAdd.description')}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={inputRef}
            id={inputId}
            label={t('quickAdd.inputLabel')}
            placeholder={t('quickAdd.placeholder')}
            value={text}
            maxLength={QUICK_ADD_TEXT_MAX_LENGTH}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={handleKeyDown}
            className="py-3! text-lg!"
          />

          {/* A failed reading is said to be one, never drawn as an empty
              reading. Outline: Save stays the dialog's one primary. */}
          {reading.status === 'failed' && (
            <div role="alert">
              <EmptyState
                className="py-4"
                icon={<ExclamationTriangleIcon />}
                title={t('quickAdd.readFailed')}
                action={
                  <Button type="button" size="sm" variant="outline" onClick={reading.retry}>
                    {t('quickAdd.tryAgain')}
                  </Button>
                }
              />
            </div>
          )}

          {shown && (
            <QuickAddChips
              reading={shown}
              stale={reading.status === 'pending'}
              editing={editing}
              onEditingChange={setEditing}
              accounts={accounts}
              payees={payees}
              categories={categories}
              onPin={(patch) => setPins((prev) => mergePins(prev, patch))}
            />
          )}

          <p role="status" className="min-h-5 text-xs text-gray-500 dark:text-gray-400">
            {reading.status === 'pending' ? t('quickAdd.reading') : ''}
          </p>

          {shown && (
            <div
              aria-busy={reading.status === 'pending'}
              className={reading.status === 'pending' ? 'opacity-60' : undefined}
            >
              <QuickAddSummary reading={shown} />
            </div>
          )}

          <FormActions
            onCancel={formModal.close}
            isSubmitting={isSaving}
            submitDisabled={!canSave}
            secondaryActions={
              <Button type="button" variant="outline" onClick={handleFullForm} disabled={isSaving}>
                {t('quickAdd.fullForm')}
              </Button>
            }
            submitOptions={[
              { id: 'close', label: t('quickAdd.save'), description: t('form.submitCreateDescription') },
              { id: 'new', label: t('quickAdd.saveAndNew'), description: t('quickAdd.saveAndNewDescription') },
            ]}
            selectedSubmitOptionId={submitMode}
            onSubmitOptionChange={(id) => setSubmitMode(id === 'new' ? 'new' : 'close')}
            submitOptionsLabel={t('form.submitOptions')}
          />
        </form>
      </Modal>
      <UnsavedChangesDialog
        {...formModal.unsavedChangesDialog}
        saveDisabledReason={canSave ? undefined : t('quickAdd.cannotSave')}
      />
    </>
  );
}
