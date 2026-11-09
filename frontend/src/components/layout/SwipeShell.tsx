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
import { HelpSearchShortcut } from '@/components/help/HelpSearchShortcut';
import { CommandPaletteShortcut } from '@/components/command-palette/CommandPaletteShortcut';
import { KeyboardShortcutsHost } from '@/components/help/KeyboardShortcutsHost';
import { useHelpStore } from '@/store/helpStore';
import { useSwipeNavigation } from '@/hooks/useSwipeNavigation';
import { useScrollToTopOnNavigation } from '@/hooks/useScrollToTopOnNavigation';
import { usePushResumeOnSignIn } from '@/hooks/usePushResumeOnSignIn';
import { cn } from '@/lib/utils';

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
  // over it, so the page makes room for the panel's width, which the reader
  // can change. A dynamic width cannot be a Tailwind class, so the panel
  // publishes it as `--help-panel-width` on the root (`useHelpWidthVar`) and the
  // literal `xl:pr-(--help-panel-width)` reads it; this component measures
  // nothing and does not re-render while the panel is dragged. Narrower screens
  // leave the panel over the page, as the assistant sheet is.
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
      className={cn(
        'min-h-screen bg-gray-50 dark:bg-gray-900 overflow-x-clip',
        helpDocked && 'xl:pr-(--help-panel-width)',
      )}
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
      <HelpSearchShortcut />
      <CommandPaletteShortcut />
      <KeyboardShortcutsHost />
    </div>
  );
}
