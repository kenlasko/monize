'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/Button';
import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * The "Scan document" button and the hidden input behind it.
 *
 * Deliberately a sibling of the plain upload rather than a replacement for it:
 * a photo picked through Upload is stored exactly as it was taken, and only a
 * file chosen here goes through the scanner. Nothing detects a document on the
 * ordinary path, so an ordinary attachment is never modified by surprise.
 *
 * On a phone the input carries `capture="environment"`, which hands off to the
 * OS camera and opens the rear lens. That attribute is not governed by the
 * `Permissions-Policy: camera=()` header this app sends -- that policy covers
 * `getUserMedia`, an in-page viewfinder, which the scanner deliberately does
 * not use.
 */
export function ScanDocumentControl({
  onFileSelected,
  loading,
  disabled,
}: {
  onFileSelected: (file: File) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations('attachments');
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a retake or an error.
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
        onClick={() => inputRef.current?.click()}
      >
        {t('scan.button')}
      </Button>
      <input
        ref={inputRef}
        type="file"
        // Any image, not the attachment whitelist: the scanner re-encodes what
        // it produces as a JPEG, so a HEIC from an iPhone is scannable even
        // though it could not be attached as it stands.
        accept="image/*"
        {...(isMobile ? { capture: 'environment' as const } : {})}
        className="hidden"
        aria-label={t('scan.button')}
        onChange={handleChange}
      />
    </>
  );
}
