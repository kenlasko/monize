'use client';


import { ReactNode, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { AppHeader } from './AppHeader';
import { DelegationBanner } from './DelegationBanner';
import { BackendDownBanner } from './BackendDownBanner';
import { DemoModeBanner } from './DemoModeBanner';
import { HttpWarningBanner } from './HttpWarningBanner';
import { SwipeIndicator } from './SwipeIndicator';
import { PushEnableBanner } from './PushEnableBanner';
import { ShareStashSweeper } from '@/components/share/ShareStashSweeper';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { WeakJwtSecretBanner } from './WeakJwtSecretBanner';
import { AiChatBubble } from '@/components/ai/AiChatBubble';
import { HelpPanelLoader } from '@/components/help/HelpPanelLoader';
import { useHelpStore } from '@/store/helpStore';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { useScrollToTopOnNavigation } from '@/hooks/useScrollToTopOnNavigation';
import { usePushResumeOnSignIn } from '@/hooks/usePushResumeOnSignIn';

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
  // Push held across this account's own sign-out resumes here, whichever
  // sign-in path brought the reader in. A no-op without a held marker.
  usePushResumeOnSignIn();

  const isAuthRoute = AUTH_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));

  // The help panel is not mounted on the sign-in screens, so an open (pinned)
  // panel must not wait there to reappear after the next sign-in.
  useEffect(() => {
    if (isAuthRoute) useHelpStore.getState().close();
  }, [isAuthRoute]);

  // Docked on a wide screen the help panel sits beside the page rather than
  // over it, so the page makes room (420px: HELP_PANEL_WIDTH). Narrower
  // screens leave it over the page, as the assistant sheet is.
  const helpDocked = useHelpStore((s) => s.open && !s.expanded);

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
    <div
      className={`min-h-screen bg-gray-50 dark:bg-gray-900 overflow-x-clip${
        helpDocked ? ' xl:pr-[420px]' : ''
      }`}
    >
      <AppHeader />
      <DelegationBanner />
      <HttpWarningBanner httpsHeadersActive={httpsHeadersActive} />
      <BackendDownBanner httpsHeadersActive={httpsHeadersActive} />
      <DemoModeBanner />
      <UpdateAvailableBanner />
      <WeakJwtSecretBanner />
      <PushEnableBanner />
      {/* Renders nothing: the stash lifetime sweep, all that is left of the
          share inbox banner that used to sit here. */}
      <ShareStashSweeper />
      <SwipeIndicator currentIndex={currentIndex} totalPages={totalPages} isSwipePage={isSwipePage} />
      <div ref={contentRef}>
        {children}
      </div>
      <AiChatBubble />
      <HelpPanelLoader />
    </div>
  );
}
