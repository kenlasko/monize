'use client';

import { useState } from 'react';
import { institutionLogoUrl } from '@/lib/institutions';

export interface InstitutionLogoData {
  id: string;
  name: string;
  hasLogo: boolean;
}

interface InstitutionLogoProps {
  institution?: InstitutionLogoData | null;
  /** Rendered square size in pixels. */
  size?: number;
  className?: string;
  /** Glyph shown when there is no institution (e.g. cashflow-only accounts). */
  fallbackGlyph?: string;
}

/**
 * Renders an institution's brand favicon (served from our own backend, never a
 * third party) with a neutral letter/glyph badge fallback when no logo is
 * cached or the image fails to load.
 */
export function InstitutionLogo({
  institution,
  size = 20,
  className = '',
  fallbackGlyph = '$',
}: InstitutionLogoProps) {
  const [errored, setErrored] = useState(false);

  // Reset the error flag when the institution changes, using the
  // "info from previous render" pattern (no setState in an effect).
  const [prevId, setPrevId] = useState(institution?.id);
  if (institution?.id !== prevId) {
    setPrevId(institution?.id);
    setErrored(false);
  }

  const dimension = { width: size, height: size };
  const letter =
    institution?.name?.trim()?.charAt(0)?.toUpperCase() || fallbackGlyph;

  if (institution?.hasLogo && !errored) {
    return (
      // Favicons are tiny, dynamic, and served from our own backend; next/image
      // optimization adds no value and cannot follow the onError fallback.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={institutionLogoUrl(institution.id)}
        alt={institution.name}
        loading="lazy"
        style={dimension}
        onError={() => setErrored(true)}
        // Circular chip with no forced backing: transparent favicons keep their
        // transparency, opaque ones fill the circle. The ring keeps it defined
        // against any background.
        className={`shrink-0 rounded-full object-contain ring-1 ring-black/10 dark:ring-white/15 ${className}`}
      />
    );
  }

  return (
    <span
      style={dimension}
      aria-hidden="true"
      className={`shrink-0 inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs font-semibold ${className}`}
    >
      {letter}
    </span>
  );
}
