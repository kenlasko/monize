'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppHeader } from './AppHeader';
import { DelegationBanner } from './DelegationBanner';
import { BackendDownBanner } from './BackendDownBanner';
import { DemoModeBanner } from './DemoModeBanner';
import { HttpWarningBanner } from './HttpWarningBanner';
import { SwipeIndicator } from './SwipeIndicator';
import { PushEnableBanner } from './PushEnableBanner';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { AiChatBubble } from '@/components/ai/AiChatBubble';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { useScrollToTopOnNavigation } from '@/hooks/useScrollToTopOnNavigation';

const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password', '/setup-2fa', '/change-password'];

interface SwipeShellProps {
  children: ReactNode;
  httpsHeadersActive?: boolean;
}

export function SwipeShell({ children, httpsHeadersActive = false }: SwipeShellProps) {
  const pathname = usePathname();
  const { contentRef, currentIndex, totalPages, isSwipePage } = useSwipeNavigation();
  // Land at the top of the page on forward tab/swipe navigation so the
  // title and action buttons are always in view. Back/Forward keep their
  // restored scroll position.
  useScrollToTopOnNavigation();

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
      <DelegationBanner />
      <HttpWarningBanner httpsHeadersActive={httpsHeadersActive} />
      <BackendDownBanner httpsHeadersActive={httpsHeadersActive} />
      <DemoModeBanner />
      <UpdateAvailableBanner />
      <PushEnableBanner />
      <SwipeIndicator currentIndex={currentIndex} totalPages={totalPages} isSwipePage={isSwipePage} />
      <div ref={contentRef}>
        {children}
      </div>
      <AiChatBubble />
    </div>
  );
}
