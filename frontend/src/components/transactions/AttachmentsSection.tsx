'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select } from '@/components/ui/Select';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { attachmentsApi, attachmentDownloadUrl } from '@/lib/attachments';
import { AttachmentPreviewDialog, type PreviewTarget } from './AttachmentPreviewDialog';
import { DocumentScanDialog, type ScanOutcome } from './DocumentScanDialog';
import { ScanDocumentControl } from './ScanDocumentControl';
import {
  StagedAttachment,
  Attachment,
  AttachmentParent,
  ACCEPTED_ATTACHMENT_TYPES,
  DOCUMENT_KINDS,
  DocumentKind,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
} from '@/types/attachment';

const logger = createLogger('AttachmentsSection');

/**
 * Saved mode: manages the attachments of an existing transaction directly
 * against the server. Warranty mode: the same saved list for a warranty's
 * documents, each row carrying its document kind; a new document is stored
 * as `other` and the reader sets its kind on its row. Staged mode: holds files
 * client-side for a transaction that does not exist yet (the New Transaction
 * window, or the New Warranty window with `stagedFor: 'warranty'`); the parent
 * form uploads them once the transaction or warranty has been created.
 */
type AttachmentsSectionProps =
  | { transactionId: string }
  | {
      warrantyId: string;
      /**
       * List and preview only: no upload, scan, kind picker or delete. An
       * acting delegate reads a warranty's documents but never changes them.
       */
      readOnly?: boolean;
    }
  | {
      stagedFiles: StagedAttachment[];
      onStagedFilesChange: (files: StagedAttachment[]) => void;
      /**
       * The row the files will be uploaded to once it exists. A warranty's
       * staged files are its Documents, and say so; the default is a
       * transaction's attachments.
       */
      stagedFor?: SavedParentKind;
      pendingHint?: string;
      headerActions?: React.ReactNode;
      hasSavedAttachments?: boolean;
    };

type SavedParentKind = 'transaction' | 'warranty';


/**
 * Validate a freshly selected file against the shared limits. Returns a
 * translated error message when the file is rejected, or null when it is
 * acceptable. `currentCount` is the number of attachments already present
 * (existing + pending) so the per-parent cap is enforced consistently in
 * both modes; `tooManyMessage` names the parent (a transaction's attachments
 * or a warranty's documents).
 */
function validateSelection(
  file: File,
  currentCount: number,
  t: (key: string, values?: Record<string, string | number>) => string,
  // A pure function cannot call the hook, so the component hands its formatter
  // down -- the `NumberFormatters` pattern, for one formatter.
  formatBytes: (bytes: number) => string,
  tooManyMessage: string,
): string | null {
  if (currentCount >= MAX_ATTACHMENTS_PER_TRANSACTION) {
    return tooManyMessage;
  }
  if (!ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
    return t('unsupported');
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return t('tooLarge', { max: formatBytes(MAX_ATTACHMENT_BYTES) });
  }
  return null;
}

/**
 * The section title with the Scan and Add controls, shared by both modes.
 *
 * On a phone the title takes a line of its own and the two buttons share the
 * next one edge to edge: beside the title, two labelled buttons overran the
 * dialog's width. The buttons are grid items there, so they stretch to their
 * half without knowing about the layout -- each control's hidden file input
 * is `display: none` and takes no cell. From `sm` up the title and the
 * buttons sit on one line as before.
 */
function AttachmentsHeader({
  children,
  heading,
  label,
}: {
  children: React.ReactNode;
  /**
   * A section heading in place of the "Attachments" label, for a page where
   * the list is a section of its own (a warranty's Documents) rather than a
   * field of a form.
   */
  heading?: string;
  /** A field label in place of "Attachments", for a form that is not a transaction's. */
  label?: string;
}) {
  const t = useTranslations('attachments');
  return (
    <div
      data-testid="attachments-header"
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    >
      {heading ? (
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {heading}
        </h2>
      ) : (
        <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label ?? t('title')}
        </span>
      )}
      <div
        data-testid="attachments-actions"
        className="grid grid-cols-2 gap-2 sm:flex sm:items-center"
      >
        {children}
      </div>
    </div>
  );
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
 * The documents of one linked warranty, as a transaction's list carries them
 * after its own rows.
 */
interface WarrantyDocumentGroup {
  warrantyId: string;
  warrantyName: string | null;
  attachments: Attachment[];
}

/**
 * Splits a transaction's list into its own rows and the documents of each
 * linked warranty, in the order the server sent them. A warranty's own list
 * is all its own rows.
 */
function splitByOwner(
  list: Attachment[],
  isWarranty: boolean,
): { own: Attachment[]; groups: WarrantyDocumentGroup[] } {
  if (isWarranty) return { own: list, groups: [] };
  const own: Attachment[] = [];
  const groups: WarrantyDocumentGroup[] = [];
  for (const attachment of list) {
    if (attachment.warrantyId === null) {
      own.push(attachment);
      continue;
    }
    let group = groups.find((g) => g.warrantyId === attachment.warrantyId);
    if (!group) {
      group = {
        warrantyId: attachment.warrantyId,
        warrantyName: attachment.warrantyName ?? null,
        attachments: [],
      };
      groups.push(group);
    }
    group.attachments.push(attachment);
  }
  return { own, groups };
}

/**
 * Lists, uploads, and deletes the saved attachments of one parent: a
 * transaction, or a warranty (whose rows also say what kind of document each
 * one is, and let the owner change it).
 *
 * A transaction's list also carries the documents of every warranty linked to
 * it, after its own rows and grouped under the warranty's name: previewed and
 * deleted the same way, with their kind shown but not edited here (that is the
 * warranty page's), and never counted against the per-transaction cap, which
 * is the transaction's own rows only. The register's paperclip count comes
 * from the same server rule, so the two agree.
 */
function SavedAttachments({
  parentKind,
  parentId,
  readOnly = false,
}: {
  parentKind: SavedParentKind;
  parentId: string;
  readOnly?: boolean;
}) {
  const t = useTranslations('attachments');
  const tw = useTranslations('warranties');
  const tc = useTranslations('common');
  const { formatBytes } = useNumberFormat();
  const groupIdPrefix = useId();
  const isWarranty = parentKind === 'warranty';
  const tooManyMessage = isWarranty
    ? tw('documents.tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION })
    : t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION });
  const parent = useMemo<AttachmentParent>(
    () =>
      parentKind === 'warranty'
        ? { warrantyId: parentId }
        : { transactionId: parentId },
    [parentKind, parentId],
  );
  // `null` until a list has loaded; a failed load is `loadFailed`, never an
  // empty list, so neither "No documents yet" nor the cap check can be drawn
  // from a list nobody has seen.
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const latestLoad = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [erroredImages, setErroredImages] = useState<Record<string, boolean>>(
    {},
  );
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The photo currently in the scan dialog, or null when it is closed. */
  const [scanning, setScanning] = useState<File | null>(null);
  /**
   * The attachment open in the preview, or null when it is closed.
   *
   * The whole target is held here rather than composed in the JSX, so it keeps
   * one identity for as long as it is on screen -- an object rebuilt on every
   * render of this list is a different subject to anything downstream.
   */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  const load = useCallback(() => {
    // The writes live in the inner function so they run after the request,
    // not during the effect that starts it.
    const request = ++latestLoad.current;
    const run = async () => {
      try {
        const list = await attachmentsApi.list(parent);
        if (latestLoad.current !== request) return;
        setAttachments(list);
        setLoadFailed(false);
      } catch (error) {
        if (latestLoad.current !== request) return;
        logger.error('Failed to load attachments:', error);
        setLoadFailed(true);
      }
    };
    return run();
  }, [parent]);

  useEffect(() => {
    load();
  }, [load]);

  /** The list the cap is checked against: only one that loaded. */
  const known = loadFailed ? null : attachments;
  const split = useMemo(
    () => (known === null ? null : splitByOwner(known, isWarranty)),
    [known, isWarranty],
  );
  /** The rows the cap counts: this parent's own, never a warranty's documents. */
  const ownCount = split === null ? null : split.own.length;

  const handleFileSelected = async (file: File) => {
    if (ownCount === null) return;
    const error = validateSelection(file, ownCount, t, formatBytes, tooManyMessage);
    if (error) {
      toast.error(error);
      return;
    }
    await upload(file);
  };

  const upload = async (file: File, original?: File) => {
    setUploading(true);
    try {
      // No kind is sent: a transaction's route takes none (W4), and a
      // warranty's new document is stored as `other` until the reader sets
      // its kind on its row.
      await attachmentsApi.upload(parent, file, original);
      toast.success(t('uploaded'));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('uploadFailed')));
    } finally {
      setUploading(false);
    }
  };

  /**
   * A photo picked for scanning is checked against the cap, and against
   * nothing else about the file.
   *
   * Neither its size nor its type says whether the scan can be attached: what
   * gets attached is the dialog's output, a JPEG capped at `OUTPUT_MAX_EDGE`,
   * so a HEIC is scannable and so is a 14 MB photo from a recent phone. The
   * size rule applied here refused exactly the captures this feature exists
   * for, and it made the dialog's own "the original is too large to keep"
   * path unreachable outside its unit test.
   */
  const handleScanSelected = (file: File) => {
    if (ownCount === null) return;
    if (ownCount >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      toast.error(tooManyMessage);
      return;
    }
    setScanning(file);
  };

  const openScanPicker = useRef<(() => void) | null>(null);
  const rememberScanPicker = useCallback((open: () => void) => {
    openScanPicker.current = open;
  }, []);

  // Retake is not Cancel: it closes the review and asks for another photo.
  // Wired to the same close, the two buttons did exactly the same thing.
  const handleScanRetake = useCallback(() => {
    setScanning(null);
    openScanPicker.current?.();
  }, []);

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

  /**
   * A warranty document's kind, changed on the spot and put back if the
   * server refuses. Each write touches only a row still showing the kind this
   * change set, so a quicker second change is never overwritten by the
   * first one's answer.
   */
  const handleKindChange = async (attachment: Attachment, kind: DocumentKind) => {
    const previous = attachment.documentKind;
    if (kind === previous) return;
    const setKindIf = (expected: DocumentKind, next: DocumentKind) =>
      setAttachments((prev) =>
        prev === null
          ? prev
          : prev.map((row) =>
              row.id === attachment.id && row.documentKind === expected
                ? { ...row, documentKind: next }
                : row,
            ),
      );
    setKindIf(previous, kind);
    try {
      const updated = await attachmentsApi.updateDocumentKind(attachment.id, kind);
      setKindIf(kind, updated.documentKind);
    } catch (error) {
      setKindIf(kind, previous);
      toast.error(getErrorMessage(error, tw('documents.kindUpdateFailed')));
    }
  };

  const atLimit = ownCount !== null && ownCount >= MAX_ATTACHMENTS_PER_TRANSACTION;

  /**
   * One saved row. The kind is a picker on the owner's view of a warranty's
   * documents, a badge on the delegate's and on a warranty document seen from
   * its transaction, and absent on a transaction's own row (always `other`).
   */
  const renderRow = (attachment: Attachment) => {
    const isImage = attachment.contentType.startsWith('image/');
    const showThumb = isImage && !erroredImages[attachment.id];
    const isWarrantyDocument = isWarranty || attachment.warrantyId !== null;
    const kindEditable = isWarranty && !readOnly;
    // With the kind picker beside it the name had little room on a phone, so
    // there the name takes its own line and the picker and Delete wrap below.
    return (
      <li
        key={attachment.id}
        className={cn(
          'flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2',
          kindEditable && 'flex-wrap sm:flex-nowrap',
        )}
      >
        {/* The row is the preview trigger: thumbnail, name and size
            in one button, with the filename as its accessible name.
            Delete stays a sibling -- a control inside a button is
            a control nobody can reach. */}
        <button
          type="button"
          onClick={() => setPreview({ kind: 'saved', attachment })}
          aria-label={t('preview.open', { name: attachment.filename })}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            kindEditable && 'basis-full sm:basis-auto',
          )}
        >
          {showThumb ? (
            // Served from our own backend; next/image adds no value and
            // cannot follow the onError fallback.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachmentDownloadUrl(attachment.id)}
              alt=""
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
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-blue-600 dark:text-blue-400 hover:underline">
              {attachment.filename}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatBytes(attachment.byteSize)}
            </span>
          </span>
        </button>
        {kindEditable && (
          <div className="min-w-0 flex-1 sm:w-40 sm:flex-none sm:shrink-0">
            <Select
              id={`document-kind-select-${attachment.id}`}
              aria-label={tw('documents.kindFor', { name: attachment.filename })}
              value={attachment.documentKind}
              className="py-1 text-xs"
              options={DOCUMENT_KINDS.map((kind) => ({
                value: kind,
                label: tw(`documents.kinds.${kind}`),
              }))}
              onChange={(event) =>
                void handleKindChange(attachment, event.target.value as DocumentKind)
              }
            />
          </div>
        )}
        {isWarrantyDocument && !kindEditable && (
          <Badge
            variant="gray"
            data-testid={`document-kind-${attachment.id}`}
            className="shrink-0"
          >
            {tw(`documents.kinds.${attachment.documentKind}`)}
          </Badge>
        )}
        {!readOnly && (
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
        )}
      </li>
    );
  };

  let body;
  if (loadFailed) {
    body = (
      <div role="alert" className="py-4 text-center space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{t('loadFailed')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false);
            void load();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  } else if (known === null) {
    body = (
      <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
        {tc('loading')}
      </p>
    );
  } else if (known.length === 0) {
    body = (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {isWarranty ? tw('documents.empty') : t('empty')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <AttachmentsHeader
        heading={isWarranty ? tw('documents.title') : undefined}
      >
        {/* Hidden until a list has loaded: the cap is checked against it. */}
        {!readOnly && known !== null && (
          <>
            <ScanDocumentControl
              onFileSelected={handleScanSelected}
              onReady={rememberScanPicker}
              disabled={uploading || atLimit}
            />
            <UploadControl
              onFileSelected={handleFileSelected}
              loading={uploading}
              disabled={uploading || atLimit}
            />
          </>
        )}
      </AttachmentsHeader>

      {body ?? (
        <>
          {split !== null && split.own.length > 0 && (
            <ul className="space-y-2">
              {split.own.map((attachment) => renderRow(attachment))}
            </ul>
          )}
          {split?.groups.map((group) => {
            const headingId = `${groupIdPrefix}-warranty-${group.warrantyId}`;
            return (
              <div
                key={group.warrantyId}
                role="group"
                aria-labelledby={headingId}
                data-testid={`warranty-documents-${group.warrantyId}`}
                className="space-y-2"
              >
                <h3
                  id={headingId}
                  className="pt-1 text-xs font-medium text-gray-500 dark:text-gray-400"
                >
                  {group.warrantyName !== null
                    ? t('fromWarranty', { name: group.warrantyName })
                    : t('fromLinkedWarranty')}
                </h3>
                <ul className="space-y-2">
                  {group.attachments.map((attachment) => renderRow(attachment))}
                </ul>
              </div>
            );
          })}
        </>
      )}

      <DocumentScanDialog
        isOpen={scanning !== null}
        file={scanning}
        onCancel={() => setScanning(null)}
        // Retake closes the dialog and leaves the control ready: the input is
        // cleared after every pick, so choosing the same photo again works.
        onRetake={handleScanRetake}
        onAccept={handleScanAccepted}
      />

      <AttachmentPreviewDialog
        isOpen={preview !== null}
        target={preview}
        onClose={() => setPreview(null)}
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
 * Holds files client-side for a transaction or warranty that does not exist
 * yet. Selected files are validated the same way as saved uploads and
 * previewed locally; the parent form uploads them once it has created the row.
 */
function StagedAttachments({
  files,
  onChange,
  stagedFor,
  pendingHint,
  headerActions,
  hasSavedAttachments = false,
}: {
  pendingHint?: string;
  headerActions?: React.ReactNode;
  hasSavedAttachments?: boolean;
  files: StagedAttachment[];
  onChange: (files: StagedAttachment[]) => void;
  stagedFor: SavedParentKind;
}) {
  const t = useTranslations('attachments');
  const tw = useTranslations('warranties');
  const isWarranty = stagedFor === 'warranty';
  const tooManyMessage = isWarranty
    ? tw('documents.tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION })
    : t('tooMany', { max: MAX_ATTACHMENTS_PER_TRANSACTION });
  const { formatBytes } = useNumberFormat();
  const [scanning, setScanning] = useState<File | null>(null);
  /** The staged entry open in the preview, or null when it is closed. */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

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
    const error = validateSelection(file, files.length, t, formatBytes, tooManyMessage);
    if (error) {
      toast.error(error);
      return;
    }
    onChange([...files, { file }]);
  };

  /** Same admission as the saved list: the cap, and nothing about the photo. */
  const handleScanSelected = (file: File) => {
    if (files.length >= MAX_ATTACHMENTS_PER_TRANSACTION) {
      toast.error(tooManyMessage);
      return;
    }
    setScanning(file);
  };

  const openScanPicker = useRef<(() => void) | null>(null);
  const rememberScanPicker = useCallback((open: () => void) => {
    openScanPicker.current = open;
  }, []);

  // Retake is not Cancel: it closes the review and asks for another photo.
  // Wired to the same close, the two buttons did exactly the same thing.
  const handleScanRetake = useCallback(() => {
    setScanning(null);
    openScanPicker.current?.();
  }, []);

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
      <AttachmentsHeader label={isWarranty ? tw('documents.title') : undefined}>
        <ScanDocumentControl
          onFileSelected={handleScanSelected}
          onReady={rememberScanPicker}
          disabled={atLimit}
        />
        <UploadControl
          onFileSelected={handleFileSelected}
          disabled={atLimit}
        />
        {headerActions}
      </AttachmentsHeader>

      {files.length === 0 ? (
        !hasSavedAttachments && <p className="text-sm text-gray-500 dark:text-gray-400">
          {isWarranty ? tw('documents.empty') : t('empty')}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {files.map(({ file, original }, index) => {
              const thumbnail = previews[index];
              return (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 p-2"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({ kind: 'file', file, original })
                    }
                    aria-label={t('preview.open', { name: file.name })}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    {thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumbnail}
                        alt=""
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
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-gray-900 dark:text-gray-100">
                        {file.name}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {formatBytes(file.size)}
                        {original ? ` · ${t('scan.originalKept')}` : ''}
                      </span>
                    </span>
                  </button>
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
            {pendingHint ?? (isWarranty ? tw('documents.pendingHint') : t('pendingHint'))}
          </p>
        </>
      )}

      <DocumentScanDialog
        isOpen={scanning !== null}
        file={scanning}
        onCancel={() => setScanning(null)}
        onRetake={handleScanRetake}
        onAccept={handleScanAccepted}
      />

      <AttachmentPreviewDialog
        isOpen={preview !== null}
        target={preview}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

/**
 * Attachment manager for a transaction or a warranty. Renders in saved mode
 * when a transaction or warranty id is supplied, or in staged mode
 * (client-side only) when given a pending file list and change handler.
 *
 * A warranty's documents are this component with a warranty parent, never a
 * second uploader: the limits, the scan pair and the preview are the same.
 */
export function AttachmentsSection(props: AttachmentsSectionProps) {
  if ('transactionId' in props) {
    return (
      <SavedAttachments
        key={`transaction:${props.transactionId}`}
        parentKind="transaction"
        parentId={props.transactionId}
      />
    );
  }
  if ('warrantyId' in props) {
    return (
      <SavedAttachments
        key={`warranty:${props.warrantyId}`}
        parentKind="warranty"
        parentId={props.warrantyId}
        readOnly={props.readOnly}
      />
    );
  }
  return (
    <StagedAttachments
      files={props.stagedFiles}
      onChange={props.onStagedFilesChange}
      stagedFor={props.stagedFor ?? 'transaction'}
      pendingHint={props.pendingHint}
      headerActions={props.headerActions}
      hasSavedAttachments={props.hasSavedAttachments}
    />
  );
}
