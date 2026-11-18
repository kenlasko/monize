'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import type { DelegateSectionGrants } from '@/lib/delegation';
import { NAV_LINKS, AI_LINKS, TOOLS_LINKS, ADMIN_LINKS } from '@/lib/nav-links';
import {
  DECISION_THRESHOLD,
  COMMIT_THRESHOLD_RATIO,
  VELOCITY_THRESHOLD,
  SWIPE_ANIMATION_MS as ANIMATION_MS,
  hasHorizontalScroll,
  isModalOpen,
  isInsidePaginationZone,
} from './swipe-gesture';

// Swipe navigation is scoped to the drawer group the current page belongs to,
// so a swipe cycles within that group and never leaves it: the main chain
// (Dashboard plus the main pages), the AI chain, the Tools chain, and the
// Admin chain. Each chain follows the drawer's own order. Settings is
// deliberately excluded from every chain: it is a terminal screen, not a view
// the user pages through. Labels are unused (the indicator draws dots), so only
// the href and its order matter -- kept in one place with the nav arrays.
interface SwipePage {
  href: string;
}
const MAIN_CHAIN: SwipePage[] = [
  { href: '/dashboard' },
  ...NAV_LINKS.map((l) => ({ href: l.href })),
];
const AI_CHAIN: SwipePage[] = AI_LINKS.map((l) => ({ href: l.href }));
const TOOLS_CHAIN: SwipePage[] = TOOLS_LINKS.map((l) => ({ href: l.href }));
const ADMIN_CHAIN: SwipePage[] = ADMIN_LINKS.map((l) => ({ href: l.href }));

// The chain that contains the current path, or an empty chain when the path
// belongs to none of them (e.g. Settings). A page reachable from no chain is
// not a swipe page.
function chainFor(pathname: string, chains: SwipePage[][]): SwipePage[] {
  return chains.find((chain) => chain.some((p) => p.href === pathname)) ?? [];
}

// Section-gated swipe pages for a delegate. The Dashboard is always
// reachable; the rest require the matching owner grant. Transactions is
// reachable when the delegate can read any non-investment account
// (delegateSections.transactions, derived server-side). Accounts stays
// per-account scoped and out of the swipe set, mirroring the delegate nav.
const DELEGATE_SECTION_BY_HREF: Record<string, keyof DelegateSectionGrants> = {
  '/accounts': 'accounts',
  '/transactions': 'transactions',
  '/bills': 'bills',
  '/investments': 'investments',
  '/budgets': 'budgets',
  '/reports': 'reports',
};

type Phase = 'idle' | 'tracking' | 'swiping';

interface TouchState {
  phase: Phase;
  startX: number;
  startY: number;
  startTime: number;
  target: EventTarget | null;
}

const IDLE_STATE: TouchState = { phase: 'idle', startX: 0, startY: 0, startTime: 0, target: null };

interface UseSwipeNavigationReturn {
  contentRef: React.RefObject<HTMLDivElement | null>;
  currentIndex: number;
  totalPages: number;
  isSwipePage: boolean;
}

export function useSwipeNavigation(): UseSwipeNavigationReturn {
  const router = useRouter();
  const pathname = usePathname();
  const contentRef = useRef<HTMLDivElement>(null);

  // A delegate acting as an owner can only swipe across the sections the
  // owner granted them (plus the Dashboard). Non-delegates swipe all pages.
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  const delegateSections = useAuthStore((s) => s.delegateSections);
  // Admin pages join the swipe chain only for a real admin who is not acting as
  // a delegate -- the same gate the header applies to the Admin menu.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const pages = useMemo(() => {
    if (isDelegateView) {
      // A delegate swipes only the Dashboard plus the main sections granted to
      // them; AI, Tools and Admin are not delegate sections, so a delegate has
      // only the (filtered) main chain to page through.
      const mainForDelegate = MAIN_CHAIN.filter((p) => {
        if (p.href === '/dashboard') return true;
        const section = DELEGATE_SECTION_BY_HREF[p.href];
        return !!section && !!delegateSections?.[section];
      });
      return chainFor(pathname, [mainForDelegate]);
    }
    // The Admin chain joins the set only for a real admin who is not acting as
    // a delegate -- the same gate the header applies to the Admin menu.
    const chains = isAdmin
      ? [MAIN_CHAIN, AI_CHAIN, TOOLS_CHAIN, ADMIN_CHAIN]
      : [MAIN_CHAIN, AI_CHAIN, TOOLS_CHAIN];
    return chainFor(pathname, chains);
  }, [isDelegateView, delegateSections, isAdmin, pathname]);

  const currentIndex = pages.findIndex((p) => pathname === p.href);
  // A lone page (e.g. a delegate granted no sections) has nothing to swipe
  // to, so treat it as a non-swipe page.
  const isSwipePage = currentIndex !== -1 && pages.length > 1;
  const currentIndexRef = useRef(currentIndex);
  const pagesRef = useRef(pages);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
    pagesRef.current = pages;
  }, [currentIndex, pages]);

  // Entrance animation: set initial off-screen position before browser paints
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const enterDir = sessionStorage.getItem('swipe-enter');
    if (!enterDir) {
      // A route change no swipe animated in (a tab, a link, Back) lands at
      // rest. The content element outlives the route, so a drag the change
      // interrupted -- Android's edge Back gesture cancels the touch and goes
      // back mid-swipe -- would otherwise carry its offset onto this page.
      content.style.transition = '';
      content.style.transform = '';
      content.style.opacity = '';
      content.style.willChange = '';
      return;
    }
    sessionStorage.removeItem('swipe-enter');

    // Clear leftover styles from exit animation (persistent DOM element)
    content.style.transition = '';
    content.style.willChange = '';

    const startX = enterDir === 'from-right' ? window.innerWidth : -window.innerWidth;
    content.style.transform = `translateX(${startX}px)`;
    content.style.opacity = '0.7';
    // Force reflow so browser registers the starting position
    content.getBoundingClientRect();
    // Animate to natural position
    content.style.transition = `transform ${ANIMATION_MS}ms ease-out, opacity ${ANIMATION_MS}ms ease-out`;
    content.style.transform = 'translateX(0)';
    content.style.opacity = '1';

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      content.removeEventListener('transitionend', cleanup);
      content.style.transition = '';
      content.style.transform = '';
      content.style.opacity = '';
    };
    content.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, ANIMATION_MS + 50);
  }, [pathname]);

  // Touch event listeners for swipe gestures
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !isSwipePage) return;

    let state: TouchState = { ...IDLE_STATE };
    let navigated = false;

    const resetStyles = () => {
      content.style.transition = '';
      content.style.transform = '';
      content.style.opacity = '';
      content.style.willChange = '';
    };

    const snapBack = () => {
      content.style.transition = `transform ${ANIMATION_MS}ms ease-out, opacity ${ANIMATION_MS}ms ease-out`;
      content.style.transform = 'translateX(0)';
      content.style.opacity = '1';

      let done = false;
      const onEnd = () => {
        if (done) return;
        done = true;
        content.removeEventListener('transitionend', onEnd);
        resetStyles();
      };
      content.addEventListener('transitionend', onEnd, { once: true });
      setTimeout(onEnd, ANIMATION_MS + 50);
    };

    // Drop the gesture without navigating. A drag already under way slides
    // back, so the page is never left sitting part way across the screen.
    const abandon = () => {
      const wasSwiping = state.phase === 'swiping';
      state = { ...IDLE_STATE };
      if (wasSwiping) snapBack();
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (navigated || !e.touches[0]) return;
      // A second finger is a pinch, not a swipe.
      if (e.touches.length > 1) {
        abandon();
        return;
      }
      // Don't start if an animation is in progress
      if (content.style.transition) return;

      state = {
        phase: 'tracking',
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTime: Date.now(),
        target: e.target,
      };
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (state.phase === 'idle' || navigated || !e.touches[0]) return;

      const deltaX = e.touches[0].clientX - state.startX;
      const deltaY = e.touches[0].clientY - state.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (state.phase === 'tracking') {
        if (absX < DECISION_THRESHOLD && absY < DECISION_THRESHOLD) return;

        if (absX > absY) {
          // Horizontal gesture — check if we can navigate in this direction
          const idx = currentIndexRef.current;
          const direction = deltaX < 0 ? 1 : -1;
          const nextIdx = idx + direction;

          if (nextIdx < 0 || nextIdx >= pagesRef.current.length) {
            state = { ...IDLE_STATE };
            return;
          }
          // A register that pages itself owns the horizontal swipe inside it,
          // so the view swipe cedes when the gesture starts in that zone --
          // the same way it cedes to a horizontally scrollable region.
          if (
            isModalOpen() ||
            hasHorizontalScroll(state.target) ||
            isInsidePaginationZone(state.target)
          ) {
            state = { ...IDLE_STATE };
            return;
          }

          state = { ...state, phase: 'swiping' };
          content.style.willChange = 'transform, opacity';
        } else {
          // Vertical scroll — stop tracking
          state = { ...IDLE_STATE };
          return;
        }
      }

      if (state.phase === 'swiping') {
        e.preventDefault();
        const screenW = window.innerWidth;
        const clamped = Math.max(-screenW, Math.min(screenW, deltaX));
        const opacity = 1 - (Math.abs(clamped) / screenW) * 0.3;
        content.style.transform = `translateX(${clamped}px)`;
        content.style.opacity = String(opacity);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (state.phase !== 'swiping' || navigated || !e.changedTouches[0]) {
        state = { ...IDLE_STATE };
        return;
      }

      const deltaX = e.changedTouches[0].clientX - state.startX;
      const absX = Math.abs(deltaX);
      const elapsed = Date.now() - state.startTime;
      const velocity = elapsed > 0 ? absX / elapsed : 0;
      const screenW = window.innerWidth;

      const shouldCommit = absX > screenW * COMMIT_THRESHOLD_RATIO || velocity > VELOCITY_THRESHOLD;
      state = { ...IDLE_STATE };

      if (shouldCommit) {
        const direction = deltaX < 0 ? 1 : -1;
        const idx = currentIndexRef.current;
        const nextIdx = idx + direction;

        if (nextIdx >= 0 && nextIdx < pagesRef.current.length) {
          navigated = true;
          const targetX = deltaX < 0 ? -screenW : screenW;
          content.style.transition = `transform ${ANIMATION_MS}ms ease-out, opacity ${ANIMATION_MS}ms ease-out`;
          content.style.transform = `translateX(${targetX}px)`;
          content.style.opacity = '0.7';

          sessionStorage.setItem('swipe-enter', deltaX < 0 ? 'from-right' : 'from-left');

          let done = false;
          const onEnd = () => {
            if (done) return;
            done = true;
            content.removeEventListener('transitionend', onEnd);
            // resetStyles();
            router.push(pagesRef.current[nextIdx].href);
          };
          content.addEventListener('transitionend', onEnd, { once: true });
          setTimeout(onEnd, ANIMATION_MS + 50);
          return;
        }
      }

      snapBack();
    };

    // The browser or the OS took the touch away mid-gesture: Android's edge
    // Back gesture, the notification shade, an incoming call. No touchend
    // follows, so without this the drag's offset would stay on the page.
    const handleTouchCancel = () => {
      if (navigated) return;
      abandon();
    };

    content.addEventListener('touchstart', handleTouchStart, { passive: true });
    content.addEventListener('touchmove', handleTouchMove, { passive: false });
    content.addEventListener('touchend', handleTouchEnd, { passive: true });
    content.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      content.removeEventListener('touchstart', handleTouchStart);
      content.removeEventListener('touchmove', handleTouchMove);
      content.removeEventListener('touchend', handleTouchEnd);
      content.removeEventListener('touchcancel', handleTouchCancel);
      // Listeners rebinding mid-drag would orphan the drag's offset.
      if (state.phase === 'swiping') resetStyles();
    };
  }, [isSwipePage, router, pathname]);

  return {
    contentRef,
    currentIndex,
    totalPages: pages.length,
    isSwipePage,
  };
}
