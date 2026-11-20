'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
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
import { isQuickAddTextTooLong, QUICK_ADD_TEXT_MAX_LENGTH } from '@/lib/quick-add';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import type { QuickAddInterpretation, QuickAddPins } from '@/types/quick-add';
import { ReactivatePayeeDialog } from '@/components/payees/ReactivatePayeeDialog';
import type { TransactionFormDraft } from '../transaction-form-draft';
import { QuickAddChips } from './QuickAddChips';
import { QuickAddSummary } from './QuickAddSummary';
import { hasPins, mergePins, pinsWithoutIds, type QuickAddChipField } from './quick-add-chips';
import { buildQuickAddDraft } from './quick-add-entry';
import { useQuickAddInterpretation, type QuickAddSettled } from './useQuickAddInterpretation';
import { useQuickAddSave } from './useQuickAddSave';

/**
 * What the reader asked for while the reading of the line was still on its
 * way, kept with the request it waits for and the line as it stood.
 */
interface WaitingAction {
  key: string;
  text: string;
  pins: QuickAddPins;
  action: { kind: 'save'; mode: TransactionSubmitMode } | { kind: 'fullForm' };
}

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
 * clears the line for the next one. Either, or Full Form, pressed while the
 * line is still being read acts on its reading once it arrives.
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
  const [submitMode, setSubmitMode] = useTransactionSubmitMode(TRANSACTION_SUBMIT_MODE_KEY);
  // Enter or Full Form pressed before the line's reading arrived.
  const waiting = useRef<WaitingAction | null>(null);

  const saver = useQuickAddSave({
    onSaved: (mode) => {
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
    },
    // The payee exists now: a second Save links it rather than making it again.
    onPayeeKept: (payee) => setPins((prev) => mergePins(prev, { payeeId: payee.id, payeeName: undefined })),
  });

  /**
   * The entry for New Transaction: the reading when there is one; otherwise
   * the typed line as the description beside the pins, less any pin the
   * server refused, so the reader's words are never lost.
   */
  const draftFor = (
    interpretation: QuickAddInterpretation | null,
    line: { text: string; pins: QuickAddPins },
    refused: boolean,
  ): TransactionFormDraft =>
    buildQuickAddDraft(interpretation, {
      text: line.text,
      pins: refused ? pinsWithoutIds(line.pins) : line.pins,
    });

  // An action taken while the reading was pending acts on THAT reading: Full
  // Form hands it over, and Enter saves it only if nothing blocks it (the
  // blockers are on screen otherwise). A line changed since is a new entry,
  // and the reader's next key decides it.
  const onReadingSettled = (key: string, settled: QuickAddSettled) => {
    const waited = waiting.current;
    if (waited === null) return;
    waiting.current = null;
    if (waited.key !== key) return;
    if (waited.action.kind === 'fullForm') {
      onFullForm(
        draftFor(settled.outcome === 'ready' ? settled.interpretation : null, waited, settled.outcome === 'refused'),
      );
    } else if (settled.outcome === 'ready' && settled.interpretation.blockers.length === 0) {
      void saver.save(settled.interpretation, waited.action.mode);
    }
  };

  const reading = useQuickAddInterpretation(
    { text, pins, today, contextAccountId },
    { onSettled: onReadingSettled },
  );
  const current = reading.interpretation;
  const canSave = !!current && current.blockers.length === 0 && !saver.isSaving;

  useFormDirtyNotify(text.trim() !== '' || hasPins(pins), formModal.setFormDirty);

  // Save from the unsaved-changes dialog saves and closes, as New Transaction's does.
  const saveRef = useRef(() => {});
  useEffect(() => {
    saveRef.current = () => {
      if (current) void saver.save(current, 'close');
    };
  });
  useEffect(() => {
    const submitRef = formModal.formSubmitRef;
    submitRef.current = () => saveRef.current();
    return () => {
      submitRef.current = null;
    };
  }, [formModal.formSubmitRef]);

  const requestSave = (mode: TransactionSubmitMode) => {
    if (canSave && current) {
      void saver.save(current, mode);
    } else if (reading.status === 'pending' && !saver.isSaving) {
      waiting.current = { key: reading.key, text, pins, action: { kind: 'save', mode } };
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    requestSave(event.shiftKey ? 'new' : submitMode);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    requestSave(submitMode);
  };

  // In a browser the press on Full Form first blurs an open amount editor,
  // which pins its figure and sends the line to be read again: so Full Form
  // waits for that reading rather than handing over the one it replaces.
  const handleFullForm = () => {
    if (reading.status === 'pending') {
      waiting.current = { key: reading.key, text, pins, action: { kind: 'fullForm' } };
      return;
    }
    onFullForm(draftFor(current, { text, pins }, reading.status === 'refused'));
  };

  // The server refused a pin: the reader's chip choices start over.
  const clearChanges = () => {
    setPins({});
    setEditing(null);
  };

  const shown = reading.shown;
  const tooLong = isQuickAddTextTooLong(text);

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
            error={tooLong ? t('quickAdd.tooLong') : undefined}
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

          {/* A refused pin is not a failed request: asking again cannot help,
              clearing the chip choices can. */}
          {reading.status === 'refused' && (
            <div role="alert">
              <EmptyState
                className="py-4"
                icon={<ExclamationTriangleIcon />}
                title={t('quickAdd.pinRefused.title')}
                description={t('quickAdd.pinRefused.description')}
                action={
                  <Button type="button" size="sm" variant="outline" onClick={clearChanges}>
                    {t('quickAdd.pinRefused.clearChanges')}
                  </Button>
                }
              />
            </div>
          )}

          {shown && (
            <QuickAddChips
              reading={shown}
              pins={pins}
              stale={reading.status === 'pending'}
              editing={editing}
              onEditingChange={setEditing}
              accounts={accounts}
              payees={payees}
              categories={categories}
              onPin={(patch) => setPins((prev) => mergePins(prev, patch))}
            />
          )}

          {/* One tight group: the status line keeps its height so the card does not jump. */}
          <div className="-mt-2 space-y-1">
            <p role="status" className="min-h-4 text-xs text-gray-500 dark:text-gray-400">
              {reading.status === 'pending' ? t('quickAdd.reading') : ''}
            </p>

            {shown && (
              <div
                aria-busy={reading.status === 'pending'}
                className={reading.status === 'pending' ? 'opacity-60' : undefined}
              >
                <QuickAddSummary reading={shown} accounts={accounts} />
              </div>
            )}
          </div>

          <FormActions
            onCancel={formModal.close}
            isSubmitting={saver.isSaving}
            submitDisabled={!canSave}
            secondaryActions={
              <Button type="button" variant="outline" onClick={handleFullForm} disabled={saver.isSaving}>
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
      <ReactivatePayeeDialog {...saver.reactivationDialog} />
    </>
  );
}
