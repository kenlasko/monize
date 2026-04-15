'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppHeader } from './AppHeader';
import { BackendDownBanner } from './BackendDownBanner';
import { DemoModeBanner } from './DemoModeBanner';
import { HttpWarningBanner } from './HttpWarningBanner';
import { SwipeIndicator } from './SwipeIndicator';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';

const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password', '/setup-2fa', '/change-password'];

interface SwipeShellProps {
  children: ReactNode;
  httpsHeadersActive?: boolean;
}

export function SwipeShell({ children, httpsHeadersActive = false }: SwipeShellProps) {
  const pathname = usePathname();
  const { contentRef, currentIndex, totalPages, isSwipePage } = useSwipeNavigation();

  const isAuthRoute = AUTH_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));

  if (isAuthRoute) {
    return (
      <>
        <HttpWarningBanner httpsHeadersActive={httpsHeadersActive} />
        <BackendDownBanner httpsHeadersActive={httpsHeadersActive} />
        {children}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 overflow-x-clip">
      <AppHeader />
      <HttpWarningBanner httpsHeadersActive={httpsHeadersActive} />
      <BackendDownBanner httpsHeadersActive={httpsHeadersActive} />
      <DemoModeBanner />
      <UpdateAvailableBanner />
      <SwipeIndicator currentIndex={currentIndex} totalPages={totalPages} isSwipePage={isSwipePage} />
      <div ref={contentRef}>
        {children}
      </div>
    </div>
  );
}
