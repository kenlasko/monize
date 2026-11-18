'use client';

import { useState, type ReactNode } from 'react';

/**
 * The app header's surface: opaque where the browser cannot blur, otherwise
 * translucent over a blur of what scrolls beneath, with the same hairline
 * under it. A bar pinned beside the header wears the same surface so the two
 * read as one piece of chrome.
 */
export const HEADER_SURFACE_CLASS =
  'bg-white dark:bg-gray-800 supports-[backdrop-filter]:bg-white/75 supports-[backdrop-filter]:dark:bg-gray-800/70 supports-[backdrop-filter]:backdrop-blur-md supports-[backdrop-filter]:backdrop-saturate-150 border-b border-gray-200/80 dark:border-white/5';

interface FloatingPageBarProps {
  /** Whether the bar is shown: it slides down into view and back up out of it. */
  visible: boolean;
  /** Test id on the fixed wrapper. */
  testId?: string;
  children: ReactNode;
}

/**
 * A full-width bar pinned to the top of the page, directly under the app
 * header and at the very top once the header has slid away
 * (`--app-header-offset`), for a page whose own summary of what it shows has
 * scrolled out of view: the Transactions page's account, the Investments
 * page's accounts, every other page's section name. The bar itself stays
 * mounted so it can slide both ways; while hidden it is inert and hidden from
 * assistive technology. Its contents mount the first time it is shown and
 * leave once it has slid away, so a page that is never scrolled carries no
 * second copy of its controls. Its contents keep the page's own gutters, so
 * they line up with what is below.
 */
export function FloatingPageBar({ visible, testId, children }: FloatingPageBarProps) {
  const [hasContent, setHasContent] = useState(visible);
  if (visible && !hasContent) setHasContent(true);

  return (
    <div
      data-testid={testId}
      // The docs capture hides pinned bars by this mark (e2e/docs-screenshots/capture.ts).
      data-floating-page-bar=""
      aria-hidden={!visible}
      inert={!visible}
      onTransitionEnd={(event) => {
        if (!visible && event.target === event.currentTarget) setHasContent(false);
      }}
      className={`pointer-events-none fixed inset-x-0 top-[calc(4rem+env(safe-area-inset-top)-var(--app-header-offset,0px))] z-30 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none ${
        visible ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'
      }`}
    >
      <div
        className={`${HEADER_SURFACE_CLASS} px-4 shadow-md sm:px-6 lg:px-12 ${
          visible ? 'pointer-events-auto' : ''
        }`}
      >
        {hasContent && children}
      </div>
    </div>
  );
}
