import { ReactNode } from 'react';
import { AppHeader } from './AppHeader';

interface PageLayoutProps {
  children: ReactNode;
}

/**
 * Standard page layout wrapper that provides consistent structure across all pages.
 * Includes the app header and standard background styling.
 */
export function PageLayout({ children }: PageLayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />
      {children}
    </div>
  );
}
