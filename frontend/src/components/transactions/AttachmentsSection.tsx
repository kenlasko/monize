'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { getErrorMessage } from '@/lib/errors';
import { attachmentsApi, attachmentDownloadUrl } from '@/lib/attachments';
import { DocumentScanDialog, type ScanOutcome } from './DocumentScanDialog';
import { ScanDocumentControl } from './ScanDocumentControl';
import {
  StagedAttachment,
  Attachment,
  ACCEPTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from '@/types/attachment';

/**
 * Saved mode: manages the attachments of an existing transaction directly
 * against the server. Staged mode: holds files client-side for a transaction
 * that does not exist yet (the New Transaction window); the parent form uploads
 * them once the transaction has been created.
 */
type AttachmentsSectionProps =
  | { transactionId: string }
  | {
      stagedFiles: StagedAttachment[];
      onStagedFilesChange: (files: StagedAttachment[]) => void;
    };

/** Human-readable byte size (e.g. 1.4 MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Validate a freshly selected file against the shared limits. Returns a
 * translated error message when the file is rejected, or null when it is
 * acceptable. `currentCount` is the number of attachments already present
 * (existing + pending) so the per-transaction cap is enforced consistently in
 * both modes.
 */
function validateSelection(
  file: File,
  currentCount: number,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (currentCount >= MAX_ATTACHMENTS_PER_TRANSACTION) {
    return t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION });
  }
  if (!ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
    return t('unsupported');
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return t('tooLarge', { max: formatBytes(MAX_ATTACHMENT_BYTES) });
  }
  return null;
}

/** The Add-attachment button plus its hidden file input, shared by both modes. */
function UploadControl({
  onFileSelected,
  loading,
  disabled,
}: {
  onFileSelected: (file: File) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations('attachments');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after an error/removal.
    event.target.value = '';
    if (file) onFileSelected(file);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        isLoading={loading}
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
      >
        {t('upload')}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_ATTACHMENT_TYPES.join(',')}
        className="hidden"
        aria-label={t('upload')}
        onChange={handleChange}
      />
    </>
  );
}

/**
 * Lists, uploads, and deletes the file attachments for a saved transaction.
 */
function SavedAttachments({ transactionId }: { transactionId: string }) {
  const t = useTranslations('attachments');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [erroredImages, setErroredImages] = useState<Record<string, boolean>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The photo currently in the scan dialog, or null when it is closed. */
  const [scanning, setScanning] = useState<File | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await attachmentsApi.list(transactionId);
      setAttachments(list);
    } catch (error) {
      toast.error(getErrorMessage(error, t('loadFailed')));
    }
  }, [transactionId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFileSelected = async (file: File) => {
    const error = validateSelection(file, attachments.length, t);
    if (error) {
      toast.error(error);
      return;
    }
    await upload(file);
  };

  const upload = async (file: File, original?: File) => {
    setUploading(true);
    try {
      await attachmentsApi.upload(transactionId, file, original);
      toast.success(t('uploaded'));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('uploadFailed')));
    } finally {
      setUploading(false);
    }
  };

  /**
   * A photo picked for scanning is checked against the cap and the size limit
   * before the scanner runs -- a scan the user cannot attach is wasted work,
   * and worse, wasted attention. Its TYPE is not checked here: the dialog
   * re-encodes what it produces as a JPEG, so a HEIC is scannable even though
   * it could not be attached as it stands.
   */
  const handleScanSelected = (file: File) => {
    if (attachments.length >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      toast.error(t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION }));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(t('tooLarge', { max: formatBytes(MAX_ATTACHMENT_BYTES) }));
      return;
    }
    setScanning(file);
  };

  const handleScanAccepted = async (outcome: ScanOutcome) => {
    setScanning(null);
    await upload(outcome.file, outcome.original);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await attachmentsApi.delete(deleteTarget.id);
      toast.success(t('deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      toast.error(getErrorMessage(error, t('deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_TRANSACTION;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('title')}
        </span>
        <div className="flex items-center gap-2">
          <ScanDocumentControl
            onFileSelected={handleScanSelected}
            disabled={uploading || atLimit}
          />
          <UploadControl
            onFileSelected={handleFileSelected}
            loading={uploading}
            disabled={uploading || atLimit}
          />
        </div>
      </div>

      {attachments.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((attachment) => {
            const isImage = attachment.contentType.startsWith('image/');
            const showThumb = isImage && !erroredImages[attachment.id];
            return (
              <li
                key={attachment.id}
                className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2"
              >
                {showThumb ? (
                  // Served from our own backend; next/image adds no value and
                  // cannot follow the onError fallback.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={attachmentDownloadUrl(attachment.id)}
                    alt={attachment.filename}
                    loading="lazy"
                    className="h-10 w-10 shrink-0 rounded object-cover"
                    onError={() =>
                      setErroredImages((prev) => ({
                        ...prev,
                        [attachment.id]: true,
                      }))
                    }
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-lg"
                  >
                    {attachment.contentType === 'application/pdf' ? '📄' : '📎'}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={attachmentDownloadUrl(attachment.id)}
                    download={attachment.filename}
                    className="block truncate text-sm text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {attachment.filename}
                  </a>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatBytes(attachment.byteSize)}
                  </span>
                  {/* A scan pair is one attachment: the photo it came from is
                      reached from this row rather than listed as a second one. */}
                  {attachment.originalAttachmentId && (
                    <>
                      {' '}
                      <a
                        href={attachmentDownloadUrl(
                          attachment.originalAttachmentId,
                        )}
                        download
                        className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {t('scan.viewOriginalFile')}
                      </a>
                    </>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('delete')}
                  className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  onClick={() => setDeleteTarget(attachment)}
                >
                  {t('delete')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <DocumentScanDialog
        isOpen={scanning !== null}
        file={scanning}
        onCancel={() => setScanning(null)}
        // Retake closes the dialog and leaves the control ready: the input is
        // cleared after every pick, so choosing the same photo again works.
        onRetake={() => setScanning(null)}
        onAccept={handleScanAccepted}
      />

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('deleteConfirmTitle')}
        message={t('deleteConfirmMessage', { name: deleteTarget?.filename ?? '' })}
        confirmLabel={t('delete')}
        variant="danger"
        pushHistory
        onConfirm={handleDelete}
        onCancel={() => (deleting ? undefined : setDeleteTarget(null))}
      />
    </div>
  );
}

/**
 * Holds files client-side for a transaction that does not exist yet. Selected
 * files are validated the same way as saved uploads and previewed locally; the
 * parent form uploads them once it has created the transaction.
 */
function StagedAttachments({
  files,
  onChange,
}: {
  files: StagedAttachment[];
  onChange: (files: StagedAttachment[]) => void;
}) {
  const t = useTranslations('attachments');
  const [scanning, setScanning] = useState<File | null>(null);

  // Object URLs for image previews, recreated whenever the file list changes
  // and revoked on cleanup so blobs are not leaked. Guarded for environments
  // (jsdom) where createObjectURL is unavailable.
  const previews = useMemo(
    () =>
      files.map(({ file }) =>
        file.type.startsWith('image/') &&
        typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : null,
      ),
    [files],
  );
  useEffect(
    () => () => {
      previews.forEach(
        (url) =>
          url && typeof URL.revokeObjectURL === 'function' &&
          URL.revokeObjectURL(url),
      );
    },
    [previews],
  );

  const handleFileSelected = (file: File) => {
    const error = validateSelection(file, files.length, t);
    if (error) {
      toast.error(error);
      return;
    }
    onChange([...files, { file }]);
  };

  /** Same admission as the saved list: the cap and the size, not the type. */
  const handleScanSelected = (file: File) => {
    if (files.length >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      toast.error(t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION }));
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(t('tooLarge', { max: formatBytes(MAX_ATTACHMENT_BYTES) }));
      return;
    }
    setScanning(file);
  };

  const handleScanAccepted = (outcome: ScanOutcome) => {
    setScanning(null);
    // The pair is staged as one entry, so it counts once against the cap and
    // is uploaded in one request when the transaction is created.
    onChange([...files, { file: outcome.file, original: outcome.original }]);
  };

  const removeAt = (index: number) => {
    onChange(files.filter((_, i) => i !== index));
  };

  const atLimit = files.length >= MAX_ATTACHMENTS_PER_TRANSACTION;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('title')}
        </span>
        <div className="flex items-center gap-2">
          <ScanDocumentControl
            onFileSelected={handleScanSelected}
            disabled={atLimit}
          />
          <UploadControl
            onFileSelected={handleFileSelected}
            disabled={atLimit}
          />
        </div>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('empty')}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {files.map(({ file, original }, index) => {
              const preview = previews[index];
              return (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2"
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt={file.name}
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-lg"
                    >
                      {file.type === 'application/pdf' ? '📄' : '📎'}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-900 dark:text-gray-100">
                      {file.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {formatBytes(file.size)}
                      {original ? ` · ${t('scan.originalKept')}` : ''}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('remove')}
                    onClick={() => removeAt(index)}
                  >
                    {t('remove')}
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('pendingHint')}
          </p>
        </>
      )}

      <DocumentScanDialog
        isOpen={scanning !== null}
        file={scanning}
        onCancel={() => setScanning(null)}
        onRetake={() => setScanning(null)}
        onAccept={handleScanAccepted}
      />
    </div>
  );
}

/**
 * Attachment manager for a transaction. Renders in saved mode when a
 * transaction id is supplied, or in staged mode (client-side only) when given a
 * pending file list and change handler.
 */
export function AttachmentsSection(props: AttachmentsSectionProps) {
  if ('transactionId' in props) {
    return <SavedAttachments transactionId={props.transactionId} />;
  }
  return (
    <StagedAttachments
      files={props.stagedFiles}
      onChange={props.onStagedFilesChange}
    />
  );
}
