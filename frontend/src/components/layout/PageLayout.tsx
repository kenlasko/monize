'use client';

import { ReactNode } from 'react';

interface PageLayoutProps {
  children: ReactNode;
}

/**
 * Standard page layout wrapper that provides consistent background styling.
 * Header, swipe indicator, and swipe navigation are handled by SwipeShell in the root layout.
 *
 * Min-height is the space *below* the sticky AppHeader (h-16 = 4rem), not a
 * full `min-h-screen`. SwipeShell renders the sticky header in normal flow
 * above this wrapper, so `min-h-screen` here would make a short page measure
 * 4rem (header) + 100vh (content), overflowing the viewport by exactly the
 * header height -- the stray page scrollbar fixed for `/ai` in #738, but
 * present on every PageLayout page. `100dvh` keeps it correct on mobile where
 * the address bar collapses. A taller page still grows and scrolls normally.
 */
export function PageLayout({ children }: PageLayoutProps) {
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-gray-50 dark:bg-gray-900">
      {children}
    </div>
  );
}
