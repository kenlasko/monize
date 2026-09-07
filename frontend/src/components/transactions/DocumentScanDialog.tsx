'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDocumentScanner } from '@/hooks/useDocumentScanner';
import {
  encodeScan,
  scanFilename,
  toCanvas,
} from '@/lib/document-scanner/decode-image';
import type { WorkerFactory } from '@/lib/document-scanner/document-scan-client';
import type {
  Quad,
  QualityWarning,
  RawImage,
} from '@/lib/document-scanner/document-scan.types';
import { MAX_ATTACHMENT_BYTES } from '@/types/attachment';
import { formatBytes } from './AttachmentsSection';
import { DocumentCornerHandles } from './DocumentCornerHandles';

/**
 * The scan review step: what the pipeline made of the photo, and what the user
 * wants done with it.
 *
 * Two things it is careful about. Nothing here refuses a capture -- every
 * warning sits beside a way to continue, because a receipt somebody cannot
 * photograph again is worth keeping imperfect (`I5`). And the blob it hands
 * back is the one it displayed, never a re-render, so the file that gets stored
 * is the file that was approved (`I3`).
 */

/** The longest edge the preview is drawn at. */
const PREVIEW_MAX_EDGE = 460;

/** What the user chose to keep. */
export interface ScanOutcome {
  /** The attachment that will be shown: the enhanced scan, or the photo. */
  file: File;
  /** The untouched photo, when it is being kept beside the scan. */
  original?: File;
}

export interface DocumentScanDialogProps {
  isOpen: boolean;
  /** The photo the user picked or captured. */
  file: File | null;
  onCancel: () => void;
  onRetake: () => void;
  onAccept: (outcome: ScanOutcome) => void;
  /** Test seam: supplies a worker double. */
  createWorker?: WorkerFactory;
}

type PreviewMode = 'enhanced' | 'original';

/** Fit a photo into the preview box, keeping its aspect ratio. */
function previewSize(image: RawImage): { width: number; height: number } {
  const longest = Math.max(image.width, image.height);
  const scale = longest > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

/**
 * Draw pixels into a canvas element that React owns.
 *
 * A callback ref keyed on the image rather than a ref written during render:
 * changing the image gives React a new callback, so it detaches and reattaches
 * the ref and the new pixels are painted -- which is exactly the repaint that
 * is wanted, without writing to a ref while rendering.
 */
function useCanvasPainter(
  image: RawImage | null,
): (node: HTMLCanvasElement | null) => void {
  return useCallback(
    (node: HTMLCanvasElement | null) => {
      if (!node || !image) return;
      const painted = toCanvas(image);
      node.width = painted.width;
      node.height = painted.height;
      node.getContext('2d')?.drawImage(painted, 0, 0);
    },
    [image],
  );
}

export function DocumentScanDialog({
  isOpen,
  file,
  onCancel,
  onRetake,
  onAccept,
  createWorker,
}: DocumentScanDialogProps) {
  const t = useTranslations('attachments');
  const scanner = useDocumentScanner(createWorker);
  const { scan, rewarp, reset } = scanner;

  const [mode, setMode] = useState<PreviewMode>('enhanced');
  const [rotation, setRotation] = useState<0 | 1 | 2 | 3>(0);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [busy, setBusy] = useState(false);

  // Scan whatever file the parent hands over, and forget the previous result
  // when the dialog closes so a reopen never shows the last document.
  useEffect(() => {
    if (!isOpen || !file) {
      reset();
      return;
    }
    setMode('enhanced');
    setRotation(0);
    setQuad(null);
    void scan(file);
  }, [isOpen, file, scan, reset]);

  // Adopt the detected corners once, so dragging starts from the detection
  // rather than from the whole frame.
  const detectedQuad = scanner.result?.quad ?? null;
  const [adoptedFor, setAdoptedFor] = useState<Quad | null>(null);
  if (detectedQuad && adoptedFor !== detectedQuad && quad === null) {
    setAdoptedFor(detectedQuad);
    setQuad(detectedQuad);
  }

  const source = scanner.source;
  const enhanced = scanner.result?.enhanced ?? null;
  const shown = mode === 'enhanced' ? enhanced : source;
  const paint = useCanvasPainter(shown);

  const display = useMemo(
    () => (shown ? previewSize(shown) : { width: 0, height: 0 }),
    [shown],
  );

  const originalTooLarge = !!file && file.size > MAX_ATTACHMENT_BYTES;

  const handleCornerCommit = useCallback(
    (next: Quad) => {
      setQuad(next);
      void rewarp(next, rotation);
    },
    [rewarp, rotation],
  );

  const handleRotate = useCallback(() => {
    const next = ((rotation + 1) % 4) as 0 | 1 | 2 | 3;
    setRotation(next);
    if (quad) void rewarp(quad, next);
  }, [quad, rotation, rewarp]);

  const handleUseEnhanced = useCallback(async () => {
    if (!enhanced || !file) return;
    setBusy(true);
    try {
      const scanFile = await encodeScan(enhanced, scanFilename(file.name));
      // The original is dropped rather than silently rejected when it is over
      // the attachment limit; the copy beside the button says so.
      onAccept(
        originalTooLarge
          ? { file: scanFile }
          : { file: scanFile, original: file },
      );
    } finally {
      setBusy(false);
    }
  }, [enhanced, file, onAccept, originalTooLarge]);

  const handleKeepOriginal = useCallback(() => {
    if (!file) return;
    onAccept({ file });
  }, [file, onAccept]);

  const warnings: QualityWarning[] = scanner.result?.warnings ?? [];
  const status = scanner.status;

  const footer = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" onClick={onCancel}>
        {t('scan.cancel')}
      </Button>
      <Button type="button" variant="outline" onClick={onRetake}>
        {t('scan.retake')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleKeepOriginal}
        disabled={!file}
      >
        {t('scan.keepOriginal')}
      </Button>
      <Button
        type="button"
        variant="primary"
        onClick={handleUseEnhanced}
        isLoading={busy}
        disabled={status !== 'ready' || !enhanced}
      >
        {t('scan.useEnhanced')}
      </Button>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t('scan.title')}
      description={t('scan.description')}
      maxWidth="2xl"
      padding="md"
      pushHistory
      footer={footer}
    >
      <div className="space-y-4">
        {status === 'loading' && (
          <div
            className="flex flex-col items-center gap-3 py-10"
            aria-busy="true"
          >
            <LoadingSpinner />
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t('scan.analysing')}
            </p>
          </div>
        )}

        {status === 'failed' && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            <p>{t('scan.failed')}</p>
            {scanner.error && (
              <p className="mt-1 text-xs opacity-80">{scanner.error}</p>
            )}
          </div>
        )}

        {status === 'ready' && shown && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {/* Two buttons rather than a tablist: the register's Tabs
                  component owns `role="tablist"`, and this is a preview
                  switch inside a dialog, not page navigation. */}
              <Button
                type="button"
                size="sm"
                variant={mode === 'enhanced' ? 'primary' : 'outline'}
                onClick={() => setMode('enhanced')}
                aria-pressed={mode === 'enhanced'}
              >
                {t('scan.viewEnhanced')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'original' ? 'primary' : 'outline'}
                onClick={() => setMode('original')}
                aria-pressed={mode === 'original'}
              >
                {t('scan.viewOriginal')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleRotate}
              >
                {t('scan.rotate')}
              </Button>
            </div>

            <div className="flex justify-center">
              <div
                className="relative"
                style={{ width: display.width, height: display.height }}
              >
                <canvas
                  ref={paint}
                  className="h-full w-full rounded-md bg-gray-100 object-contain dark:bg-gray-800"
                  aria-label={
                    mode === 'enhanced'
                      ? t('scan.previewEnhancedAlt')
                      : t('scan.previewOriginalAlt')
                  }
                  role="img"
                />
                {/* The corners belong to the photo, so they are only drawn
                    over it -- placed over the enhanced image they would point
                    at coordinates that no longer exist. */}
                {mode === 'original' && quad && source && (
                  <DocumentCornerHandles
                    quad={quad}
                    imageWidth={source.width}
                    imageHeight={source.height}
                    displayWidth={display.width}
                    displayHeight={display.height}
                    onChange={setQuad}
                    onCommit={handleCornerCommit}
                  />
                )}
              </div>
            </div>

            {mode === 'enhanced' && (
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                {t('scan.adjustHint')}
              </p>
            )}

            {scanner.result && !scanner.result.documentFound && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('scan.noDocumentFound')}
              </p>
            )}

            {warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                {warnings.map((warning) => (
                  <li key={warning}>{t(`scan.warnings.${warning}`)}</li>
                ))}
              </ul>
            )}

            {originalTooLarge && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('scan.originalTooLarge', {
                  max: formatBytes(MAX_ATTACHMENT_BYTES),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
