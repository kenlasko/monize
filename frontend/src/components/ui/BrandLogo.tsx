'use client';

import { useState, type CSSProperties } from 'react';
import { cachedLogoBacking, logoBackingFor, type LogoBacking } from '@/lib/logo-backing';

export interface BrandLogoProps {
  /**
   * Same-origin URL for the cached favicon, or null when the entity has none.
   * Null renders the fallback badge without ever issuing a request.
   */
  src: string | null;
  /** Entity name: the image's alt text, and the source of the letter badge. */
  name?: string | null;
  /** Rendered square size in pixels. */
  size?: number;
  className?: string;
  /** Glyph shown when there is no name to take an initial from. */
  fallbackGlyph?: string;
  /** Icon shown instead of the glyph when there is no entity at all. */
  fallbackIcon?: React.ReactNode;
}

/**
 * The fill behind a transparent logo whose ink would vanish into the card,
 * applied only in the mode where it would (see `LogoBacking`). The inset keeps
 * a square logo inside the round chip once the chip is visible.
 */
const BACKING_CLASS: Record<LogoBacking, string> = {
  none: '',
  light: 'dark:bg-white dark:p-(--brand-logo-inset)',
  dark: 'bg-gray-800 p-(--brand-logo-inset) dark:bg-transparent dark:p-0',
};

/**
 * A cached brand favicon with a neutral badge fallback -- the one component
 * behind `InstitutionLogo` and `PayeeLogo`.
 *
 * The bytes are always served from our own backend, never a third party: the
 * server resolves the site's favicon once and caches it, so rendering a logo
 * cannot leak which institutions or payees a user has to anyone else. A 404
 * (no cached icon yet, or the fetch failed) lands on `onError` and shows the
 * badge, so the two "no image" paths look the same to the reader.
 *
 * A transparent logo whose dominant colour is too close to the card gets a
 * plain contrasting fill, worked out from its pixels once it has loaded
 * (`lib/logo-backing.ts`).
 */
export function BrandLogo({
  src,
  name,
  size = 20,
  className = '',
  fallbackGlyph = '$',
  fallbackIcon,
}: BrandLogoProps) {
  const [errored, setErrored] = useState(false);
  const [backing, setBacking] = useState<LogoBacking>(() => cachedLogoBacking(src) ?? 'none');

  // Reset the error flag and the backing when the image changes, using the
  // "info from previous render" pattern (no setState in an effect).
  const [prevSrc, setPrevSrc] = useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setErrored(false);
    setBacking(cachedLogoBacking(src) ?? 'none');
  }

  const dimension = { width: size, height: size };
  const letter = name?.trim()?.charAt(0)?.toUpperCase();
  const fallback = letter ?? fallbackIcon ?? fallbackGlyph;

  if (src && !errored) {
    return (
      // Favicons are tiny, dynamic, and served from our own backend; next/image
      // optimization adds no value and cannot follow the onError fallback.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? ''}
        loading="lazy"
        style={
          {
            ...dimension,
            '--brand-logo-inset': `${Math.max(1, Math.round(size / 10))}px`,
          } as CSSProperties
        }
        onLoad={(event) => setBacking(logoBackingFor(src, event.currentTarget))}
        onError={() => setErrored(true)}
        // Circular chip: transparent favicons keep their transparency unless
        // their ink would disappear into the card; opaque ones fill the circle.
        className={`shrink-0 rounded-full object-contain ${BACKING_CLASS[backing]} ${className}`}
      />
    );
  }

  return (
    <span
      style={dimension}
      aria-hidden="true"
      className={`shrink-0 inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs font-semibold ${className}`}
    >
      {fallback}
    </span>
  );
}
