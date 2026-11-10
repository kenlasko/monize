'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { FormActions } from '@/components/ui/FormActions';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { AttachmentPreviewDialog } from '@/components/transactions/AttachmentPreviewDialog';
import { SharedTransactionPicker } from '@/components/shared-expenses/SharedTransactionPicker';
import { SharedWarrantyPicker } from '@/components/shared-expenses/SharedWarrantyPicker';
import { useReportData } from '@/hooks/useReportData';
import { attachmentsApi } from '@/lib/attachments';
import { getErrorMessage } from '@/lib/errors';
import { newClientId } from '@/lib/client-id';
import { DOCUMENT_KINDS, type DocumentKind } from '@/types/attachment';

type SourceKind = 'transaction' | 'warranty';

interface WarrantyAddExistingDocumentProps {
  warrantyId: string;
  onClose: () => void;
  /** The copy is saved; the list should load it. */
  onAdded: () => void;
}

/**
 * Adds a document the reader already uploaded, to a transaction or another
 * warranty, to this warranty. The server copies it (an attachment has one
 * parent), so the source keeps its file and the warranty gets its own.
 * The pickers are the ones Shared Expenses copies a private document with.
 */
export function WarrantyAddExistingDocument({ warrantyId, onClose, onAdded }: WarrantyAddExistingDocumentProps) {
  const t = useTranslations('warranties');
  const [sourceKind, setSourceKind] = useState<SourceKind>('transaction');
  const [parentId, setParentId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [kind, setKind] = useState<DocumentKind>('receipt');
  const [preview, setPreview] = useState(false);
  // One per choice: a retry of the same copy is answered by the server with
  // the first one, and a different file or type is a new request.
  const [operationId, setOperationId] = useState(() => newClientId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestKey = `${sourceKind}:${parentId}`;
  const files = useReportData(
    () =>
      parentId
        ? attachmentsApi.list(sourceKind === 'transaction' ? { transactionId: parentId } : { warrantyId: parentId })
        : Promise.resolve(null),
    [sourceKind, parentId],
    { requestKey },
  );
  const fresh = files.dataKey === requestKey;
  // A transaction's list carries its warranties' documents too; this
  // warranty's own are already here.
  const choices = fresh ? (files.data ?? []).filter((file) => file.warrantyId !== warrantyId) : [];
  const chosen = choices.find((file) => file.id === sourceId);

  const choose = (next: { kind?: SourceKind; parent?: string }) => {
    if (next.kind) setSourceKind(next.kind);
    setParentId(next.parent ?? '');
    setSourceId('');
    setError(null);
    setOperationId(newClientId());
  };

  const add = async () => {
    if (busy || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      await attachmentsApi.copyToWarranty(warrantyId, chosen.id, kind, operationId);
      onAdded();
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause, t('documents.addExistingFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        isOpen
        title={t('documents.addExistingTitle')}
        padding="none"
        className="p-6"
        maxWidth="lg"
        onClose={busy ? undefined : onClose}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('documents.addExistingHelp')}</p>
          <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('documents.addExistingFrom')}>
            {(['transaction', 'warranty'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={sourceKind === option}
                onClick={() => choose({ kind: option })}
                className={segmentClass(sourceKind === option)}
              >
                {t(option === 'transaction' ? 'documents.fromTransaction' : 'documents.fromWarranty')}
              </button>
            ))}
          </div>
          {sourceKind === 'transaction' ? (
            <SharedTransactionPicker attachmentsOnly onChoose={(row) => choose({ parent: row.id })} />
          ) : (
            <SharedWarrantyPicker onChoose={(id) => choose({ parent: id })} />
          )}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void add();
            }}
          >
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            {files.error != null && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {t('documents.addExistingLoadFailed')}
              </p>
            )}
            {parentId && fresh && files.data && choices.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('documents.addExistingNone')}</p>
            )}
            {choices.length > 0 && (
              <>
                <Select
                  label={t('documents.addExistingDocument')}
                  value={sourceId}
                  options={[
                    { value: '', label: t('documents.choose') },
                    ...choices.map((file) => ({ value: file.id, label: file.filename })),
                  ]}
                  onChange={(event) => {
                    const next = choices.find((file) => file.id === event.target.value);
                    setSourceId(event.target.value);
                    setOperationId(newClientId());
                    // A warranty's document says what it is; a transaction's is
                    // always "other", so it starts as a receipt, never as the
                    // type an earlier choice left behind.
                    setKind(next && next.warrantyId !== null ? next.documentKind : 'receipt');
                  }}
                />
                {chosen && (
                  <>
                    <Button type="button" variant="outline" onClick={() => setPreview(true)}>
                      {t('documents.preview')}
                    </Button>
                    <Select
                      label={t('documents.addExistingKind')}
                      value={kind}
                      options={DOCUMENT_KINDS.map((option) => ({
                        value: option,
                        label: t(`documents.kinds.${option}`),
                      }))}
                      onChange={(event) => {
                        setKind(event.target.value as DocumentKind);
                        setOperationId(newClientId());
                      }}
                    />
                  </>
                )}
              </>
            )}
            <FormActions
              onCancel={onClose}
              submitLabel={t('documents.addExistingSubmit')}
              isSubmitting={busy}
              submitDisabled={!chosen}
            />
          </form>
        </div>
      </Modal>
      {preview && chosen && (
        <AttachmentPreviewDialog isOpen target={{ kind: 'saved', attachment: chosen }} onClose={() => setPreview(false)} />
      )}
    </>
  );
}
