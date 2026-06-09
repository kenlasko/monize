'use client';

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

interface InfoTooltipProps {
  /** Tooltip body text. Shown in the popover and exposed via aria-label. */
  text: string;
  /** Where the popover renders relative to the icon. Defaults to 'bottom'. */
  placement?: 'top' | 'bottom';
  /**
   * Horizontal edge the popover anchors to. Use 'right' (opens leftward) when
   * the icon sits near a container's right edge -- e.g. the right column of a
   * modal -- so the fixed-width popover doesn't overflow and get clipped.
   * Defaults to the natural alignment for the placement (left for 'bottom',
   * centered for 'top').
   */
  align?: 'left' | 'right';
  /** Tailwind size classes for the icon. Defaults to 'h-4 w-4'. */
  iconClassName?: string;
  /**
   * Render the popover in a fixed-position portal on document.body so it
   * escapes ancestors that clip overflow (e.g. a scrollable card). The
   * position is clamped to the viewport so it never gets cut off.
   */
  usePortal?: boolean;
}

const POPOVER_WIDTH = 256; // matches w-64
const VIEWPORT_MARGIN = 8;

/**
 * Inline help icon with a desktop-only hover popover. Hidden below the md
 * breakpoint because a hover popover can't be triggered on touch. The text
 * is exposed via aria-label for screen readers; no native title attribute
 * is used so the browser tooltip doesn't duplicate the styled popover.
 */
export function InfoTooltip({
  text,
  placement = 'bottom',
  align,
  iconClassName = 'h-4 w-4',
  usePortal = false,
}: InfoTooltipProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [portalPos, setPortalPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  const showPortal = useCallback(() => {
    const rect = iconRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN,
    );
    const top =
      placement === 'top' ? rect.top : rect.bottom + 4;
    setPortalPos({ top, left });
  }, [placement]);

  const hidePortal = useCallback(() => setPortalPos(null), []);

  if (usePortal) {
    return (
      <span
        ref={iconRef}
        aria-label={text}
        onMouseEnter={showPortal}
        onMouseLeave={hidePortal}
        className="relative hidden md:inline-flex items-center align-middle ml-1 text-gray-400 hover:text-blue-500 transition-colors cursor-help"
      >
        <QuestionMarkCircleIcon className={iconClassName} />
        {portalPos &&
          createPortal(
            <span
              role="tooltip"
              style={{
                position: 'fixed',
                top: portalPos.top,
                left: portalPos.left,
                width: POPOVER_WIDTH,
                transform: placement === 'top' ? 'translateY(-100%)' : undefined,
              }}
              className="pointer-events-none z-50 whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg"
            >
              {text}
            </span>,
            document.body,
          )}
      </span>
    );
  }

  const vertical = placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-1';
  const horizontal =
    align === 'right'
      ? 'right-0'
      : align === 'left'
        ? 'left-0'
        : placement === 'top'
          ? 'left-1/2 -translate-x-1/2'
          : 'left-0';
  const popoverClasses = `${horizontal} ${vertical}`;
  return (
    <span
      aria-label={text}
      className="relative hidden md:inline-flex items-center align-middle ml-1 group/tip text-gray-400 hover:text-blue-500 transition-colors cursor-help"
    >
      <QuestionMarkCircleIcon className={iconClassName} />
      <span
        role="tooltip"
        className={`pointer-events-none hidden md:group-hover/tip:block absolute z-20 w-64 whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg ${popoverClasses}`}
      >
        {text}
      </span>
    </span>
  );
}
