'use client';

import { ReactNode } from 'react';

interface PageLayoutProps {
  children: ReactNode;
}

/**
 * Standard page layout wrapper that provides consistent background styling.
 * Header, swipe indicator, and swipe navigation are handled by SwipeShell in the root layout.
 */
export function PageLayout({ children }: PageLayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {children}
    </div>
  );
}
