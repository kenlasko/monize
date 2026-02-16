'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppHeader } from './AppHeader';
import { DemoModeBanner } from './DemoModeBanner';
import { SwipeIndicator } from './SwipeIndicator';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';

const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password', '/setup-2fa', '/change-password'];

interface SwipeShellProps {
  children: ReactNode;
}

export function SwipeShell({ children }: SwipeShellProps) {
  const pathname = usePathname();
  const { contentRef, currentIndex, totalPages, isSwipePage } = useSwipeNavigation();

  const isAuthRoute = AUTH_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));

  if (isAuthRoute) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 overflow-x-hidden">
      <AppHeader />
      <DemoModeBanner />
      <SwipeIndicator currentIndex={currentIndex} totalPages={totalPages} isSwipePage={isSwipePage} />
      <div ref={contentRef}>
        {children}
      </div>
    </div>
  );
}
