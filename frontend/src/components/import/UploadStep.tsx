'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Account } from '@/types/account';
import { formatAccountType } from '@/lib/account-utils';
import { docsUrl } from '@/lib/docs-links';

interface UploadStepProps {
  preselectedAccount: Account | undefined;
  isLoading: boolean;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Files dropped onto the drop zone, already checked against the accept list. */
  onFilesDrop: (files: File[]) => void;
  /**
   * Why the last Microsoft Money file would not open. Shown here rather than
   * toasted because the useful ones are instructions -- "open and save it once
   * in Money Plus Sunset, then import the result" -- and a toast takes those
   * away while the user is still reading them.
   */
  mnyError?: { code?: string; message: string } | null;
}

function docsLink(href: string) {
  return function DocsLink(chunks: React.ReactNode) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline hover:text-amber-900 dark:hover:text-amber-100"
      >
        {chunks}
      </a>
    );
  };
}

/**
 * A drop bypasses the picker's `accept` filter, so the dropped names are checked
 * against that same attribute rather than a second list of extensions.
 */
function isAcceptedFile(file: File, accept: string): boolean {
  const name = file.name.toLowerCase();
  return accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((extension) => extension.length > 0 && name.endsWith(extension));
}

function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function UploadStep({
  preselectedAccount,
  isLoading,
  onFileSelect,
  onFilesDrop,
  mnyError = null,
}: UploadStepProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // dragenter and dragleave fire for every child the pointer crosses; counting
  // them keeps the highlight from flickering while it moves over the icon.
  const dragDepth = useRef(0);

  // A file drag is always claimed, even while loading: a zone that does not
  // call preventDefault lets the browser open the released file in the tab,
  // leaving the wizard mid-upload. Only the highlight and the drop effect
  // depend on whether a drop would be taken.
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (isLoading) return;
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isLoading ? 'none' : 'copy';
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (isLoading) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const accept = inputRef.current?.accept ?? '';
    const rejected = files.filter((file) => !isAcceptedFile(file, accept));
    if (rejected.length > 0) {
      toast.error(
        t('upload.unsupportedDrop', {
          names: rejected.map((file) => file.name).join(', '),
        }),
      );
      return;
    }
    onFilesDrop(files);
  };

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-2">
          <svg
            className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
          <div className="text-sm text-amber-800 dark:text-amber-200">
            <p className="font-semibold">{t('upload.docsNotice.title')}</p>
            <p className="mt-1">
              {t.rich('upload.docsNotice.body', {
                money: docsLink(docsUrl('importMicrosoftMoney')),
                quicken: docsLink(docsUrl('importQuicken')),
              })}
            </p>
          </div>
        </div>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('upload.heading')}
        </h2>
        {preselectedAccount && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('upload.importingTo')} <strong>{preselectedAccount.name}</strong> ({formatAccountType(preselectedAccount.accountType, tc)})
            </p>
          </div>
        )}
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {t('upload.instructions')}
        </p>
        {mnyError && (
          <div
            role="alert"
            className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-6"
          >
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">
              {t('upload.mnyFailedHeading')}
            </p>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              {mnyError.message || t('mnyErrors.mnyUnreadableDatabase')}
            </p>
          </div>
        )}
        <div
          data-testid="import-drop-zone"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors motion-reduce:transition-none ${
            isDragging
              ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
              : 'border-gray-300 dark:border-gray-600'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".qif,.qmtf,.ofx,.qfx,.csv,.mny"
            multiple
            onChange={onFileSelect}
            className="hidden"
            id="import-file"
            disabled={isLoading}
          />
          <label
            htmlFor="import-file"
            className="cursor-pointer inline-flex flex-col items-center"
          >
            <svg
              className="w-12 h-12 text-gray-400 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <span className="text-gray-600 dark:text-gray-400">
              {isLoading
                ? t('upload.processing')
                : isDragging
                  ? t('upload.dropToImport')
                  : t('upload.clickToSelect')}
            </span>
            {!isLoading && !isDragging && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('upload.orDragAndDrop')}
              </span>
            )}
            <span className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {t('upload.acceptedFormats')}
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
