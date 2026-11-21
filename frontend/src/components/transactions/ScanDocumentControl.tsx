'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/Button';
import { isTouchDevice } from '@/lib/touch-device';

/**
 * The "Scan document" button and the hidden input behind it.
 *
 * Deliberately a sibling of the plain upload rather than a replacement for it:
 * a photo picked through Upload is stored exactly as it was taken, and only a
 * file chosen here goes through the scanner. Nothing detects a document on the
 * ordinary path, so an ordinary attachment is never modified by surprise.
 *
 * It is offered on touch devices only: on a desktop it would open the same file
 * picker as Add attachment. On a touch device the input carries `capture="environment"`, which hands off
 * to the OS camera and opens the rear lens. That attribute is not governed by
 * the `Permissions-Policy: camera=()` header this app sends -- that policy
 * covers `getUserMedia`, an in-page viewfinder, which the scanner deliberately
 * does not use.
 *
 * The predicate is the POINTER, not the viewport (`isTouchDevice`, and
 * `docs/frontend/ui-conventions.md`'s rule). `capture` does not merely restyle anything: on
 * a browser that honours it the OS file picker is replaced by the camera, so
 * keying it off a 639px width would take the "choose an existing photo" path
 * away from anyone with a narrow desktop window, and give it back when they
 * widened it.
 */
export function ScanDocumentControl({
  onFileSelected,
  loading,
  disabled,
  onReady,
}: {
  onFileSelected: (file: File) => void;
  loading?: boolean;
  disabled?: boolean;
  /**
   * Hands the parent a way to open the picker itself.
   *
   * Retake in the review dialog is otherwise indistinguishable from Cancel:
   * both close it, and the user is left to find the Scan document button again
   * for the action they just asked for.
   */
  onReady?: (open: () => void) => void;
}) {
  const t = useTranslations('attachments');
  // Only where the camera hands off: on a desktop the picker would be the same
  // as Add attachment, so the control is not offered at all.
  const touch = isTouchDevice();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onReady?.(() => inputRef.current?.click());
  }, [onReady]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a retake or an error.
    event.target.value = '';
    if (file) onFileSelected(file);
  };

  if (!touch) return null;

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
        {...(isTouchDevice() ? { capture: 'environment' as const } : {})}
        className="hidden"
        aria-label={t('scan.button')}
        onChange={handleChange}
      />
    </>
  );
}
