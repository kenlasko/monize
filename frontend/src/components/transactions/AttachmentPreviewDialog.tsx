'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, ButtonLink } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import {
  previewSourceKey,
  useAttachmentBytes,
  type PreviewSource,
} from '@/hooks/useAttachmentBytes';
import { attachmentDownloadUrl } from '@/lib/attachments';
import { downloadBlob } from '@/lib/download';
import type { Attachment } from '@/types/attachment';
import { PdfPages } from './PdfPages';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

/**
 * What the preview is showing: a saved attachment (its original, when it
 * has one, is reached through `originalAttachmentId` and the same download
 * route), or a file staged in the New Transaction window, with the photo it
 * was scanned from when the user kept it.
 */
export type PreviewTarget =
  | { kind: 'saved'; attachment: Pick< Attachment,
        "id" | "filename" | "contentType" | "originalAttachmentId"
      >; }
  | { kind: 'file'; file: File; original?: File };

type Variant = 'enhanced' | 'original';
type Fit = 'fit' | 'actual';

function targetName(target: PreviewTarget): string {
  return target.kind === 'saved' ? target.attachment.filename : target.file.name;
}

function hasOriginal(target: PreviewTarget): boolean {
  return target.kind === 'saved'
    ? !!target.attachment.originalAttachmentId
    : target.original !== undefined;
}

/**
 * What kind of file the preview is about to show, from the metadata the list
 * already carries rather than from the bytes still in flight.
 *
 * Asking the loaded bytes instead means the zoom controls are absent until the
 * fetch lands and then appear, shifting the picture the reader is looking at,
 * once on open and again on every switch between the scan and its photo. A
 * scan's original is an image by construction: the server refuses a pair whose
 * halves are not both images.
 */
function expectedKind(
  target: PreviewTarget,
  variant: Variant,
): 'image' | 'pdf' | 'other' {
  const type =
    target.kind === 'saved'
      ? variant === 'original' && target.attachment.originalAttachmentId
        ? 'image/'
        : target.attachment.contentType
      : (variant === 'original' && target.original
          ? target.original
          : target.file
        ).type;
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'other';
}

function sourceFor(target: PreviewTarget, variant: Variant): PreviewSource {
  if (target.kind === 'saved') {
    const id =
      variant === 'original' && target.attachment.originalAttachmentId
        ? target.attachment.originalAttachmentId
        : target.attachment.id;
    return { kind: 'saved', id };
  }
  return {
    kind: 'file',
    file: variant === 'original' && target.original ? target.original : target.file,
  };
}

/**
 * Opens an attachment inside the app instead of handing it to the browser.
 *
 * Images and PDFs are the only types an upload accepts, and both are drawn
 * here: an image from a blob URL, a PDF by `PdfPages`. Download is offered
 * from the footer for whichever variant is on screen -- for a saved original
 * the server names the file through Content-Disposition, since the list does
 * not carry the original's own filename.
 *
 * On a phone the dialog fills the viewport (`fullScreenOnPhone`); on anything
 * wider it is the ordinary centred card, tall enough to read a page.
 */
export function AttachmentPreviewDialog({
  isOpen,
  target,
  onClose,
}: {
  isOpen: boolean;
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations('attachments');
  const tCommon = useTranslations('common');

  // Variant and zoom belong to one attachment, and a different attachment
  // starts over. Keyed on WHAT is being previewed, never on the identity of
  // the prop object: a caller that builds `target` inline rebuilds it on every
  // one of its own renders, and keying on the object would throw the reader
  // back to the enhanced image, at Fit, in the middle of reading the original.
  const subject = target === null ? null : previewSourceKey(sourceFor(target, 'enhanced'));
  const [viewState, setViewState] = useState<{
    subject: string | null;
    variant: Variant;
    fit: Fit;
  }>({ subject, variant: 'enhanced', fit: 'fit' });
  if (viewState.subject !== subject) {
    setViewState({ subject, variant: 'enhanced', fit: 'fit' });
  }
  const variant = viewState.subject === subject ? viewState.variant : 'enhanced';
  const fit = viewState.subject === subject ? viewState.fit : 'fit';
  const setVariant = (next: Variant) =>
    setViewState((prev) => ({ ...prev, subject, variant: next }));
  const setFit = (next: Fit) =>
    setViewState((prev) => ({ ...prev, subject, fit: next }));
  // The element the PDF pages scroll inside, so a page is drawn when the
  // reader reaches it rather than all of them at once.
  const bodyRef = useRef<HTMLDivElement>(null);

  const source = isOpen && target ? sourceFor(target, variant) : null;
  const bytes = useAttachmentBytes(source);

  const ready = bytes?.status === 'ready' ? bytes : null;
  const isImage = ready?.contentType.startsWith('image/') ?? false;
  const isPdf = ready?.contentType === 'application/pdf';
  // Drawn from the metadata so the toolbar does not move while bytes load; the
  // loaded type still decides what the body actually renders.
  const showZoom = target !== null && (expectedKind(target, variant) === 'image' || isImage);

  // Object URLs for the image, made from the bytes on screen and revoked when
  // they change. Guarded for environments (jsdom) without createObjectURL.
  const imageUrl = useMemo(
    () =>
      ready && isImage && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(
            new Blob([ready.bytes], { type: ready.contentType }),
          )
        : null,
    [ready, isImage],
  );
  useEffect(
    () => () => {
      if (imageUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(imageUrl);
      }
    },
    [imageUrl],
  );

  if (!target) return null;

  const name = targetName(target);
  const showingOriginal = variant === 'original' && hasOriginal(target);

  const download =
    target.kind === 'saved' ? (
      <ButtonLink
        href={attachmentDownloadUrl(
          showingOriginal && target.attachment.originalAttachmentId
            ? target.attachment.originalAttachmentId
            : target.attachment.id,
        )}
        // The original's filename is the server's to give; the visible
        // attachment's is known here.
        download={showingOriginal ? '' : target.attachment.filename}
        variant="outline"
        size="md"
      >
        {t('download')}
      </ButtonLink>
    ) : (
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          const file =
            showingOriginal && target.original ? target.original : target.file;
          downloadBlob(file, file.name);
        }}
      >
        {t('download')}
      </Button>
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={name}
      maxWidth="6xl"
      pushHistory
      fullScreenOnPhone
      fixedHeight
      footer={
        <>
          {download}
          {/* Close is not the action the dialog exists for, so it is not a
              primary button. */}
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </>
      }
    >
      {(hasOriginal(target) || showZoom) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2 sm:px-6">
          {hasOriginal(target) && (
            // A segmented control rather than a tablist, as the scan dialog
            // does: a preview switch inside a dialog is not page navigation.
            <div role="group" aria-label={t('preview.versionLabel')} className={SEGMENTED_GROUP_CLASS}>
              <button
                type="button"
                onClick={() => setVariant('enhanced')}
                aria-pressed={variant === 'enhanced'}
                className={segmentClass(variant === 'enhanced')}
              >
                {t('scan.viewEnhanced')}
              </button>
              <button
                type="button"
                onClick={() => setVariant('original')}
                aria-pressed={variant === 'original'}
                className={segmentClass(variant === 'original')}
              >
                {t('scan.viewOriginal')}
              </button>
            </div>
          )}
          {showZoom && (
            <div role="group" aria-label={t('preview.zoomLabel')} className={`ml-auto ${SEGMENTED_GROUP_CLASS}`}>
              <button
                type="button"
                onClick={() => setFit('fit')}
                aria-pressed={fit === 'fit'}
                className={segmentClass(fit === 'fit')}
              >
                {t('preview.fit')}
              </button>
              <button
                type="button"
                onClick={() => setFit('actual')}
                aria-pressed={fit === 'actual'}
                className={segmentClass(fit === 'actual')}
              >
                {t('preview.actualSize')}
              </button>
            </div>
          )}
        </div>
      )}

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-auto bg-gray-100 p-4 dark:bg-gray-900"
        aria-busy={bytes?.status === 'loading'}
      >
        {bytes?.status === 'loading' && (
          <LoadingSpinner text={t('preview.loading')} />
        )}
        {bytes?.status === 'error' && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            {/*
              Two different facts, so two different messages. The generic one
              says the file can still be downloaded; when the server answered
              that it cannot reach the backend holding these bytes, the download
              is the same request and fails the same way -- and the file is not
              lost, which is what the reader most needs to know.
            */}
            {bytes.storeUnreachable
              ? t('preview.storeUnavailable')
              : t('preview.failed')}
          </div>
        )}
        {ready && isImage && imageUrl && (
          // Served from our own bytes; next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={name}
            className={
              fit === 'fit'
                ? 'mx-auto max-h-full max-w-full object-contain'
                : 'max-w-none'
            }
          />
        )}
        {ready && isPdf && (
          <PdfPages bytes={ready.bytes} scrollRootRef={bodyRef} />
        )}
        {ready && !isImage && !isPdf && (
          <p className="text-center text-sm text-gray-600 dark:text-gray-300">
            {t('preview.unsupported')}
          </p>
        )}
      </div>
    </Modal>
  );
}
