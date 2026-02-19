'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';

const SWIPE_PAGES = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/investments', label: 'Investments' },
  { href: '/bills', label: 'Bills & Deposits' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/reports', label: 'Reports' },
] as const;

const DECISION_THRESHOLD = 10; // px movement before deciding horizontal vs vertical
const COMMIT_THRESHOLD_RATIO = 0.25; // 25% of screen width to commit navigation
const VELOCITY_THRESHOLD = 0.4; // px/ms — fast swipes commit even if short
const ANIMATION_MS = 200;

function hasHorizontalScroll(element: EventTarget | null): boolean {
  let current = element as HTMLElement | null;
  while (current) {
    if (current.scrollWidth > current.clientWidth + 1) {
      const overflow = getComputedStyle(current).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function isModalOpen(): boolean {
  return document.body.style.overflow === 'hidden';
}

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

  const currentIndex = SWIPE_PAGES.findIndex((p) => pathname === p.href);
  const isSwipePage = currentIndex !== -1;
  const currentIndexRef = useRef(currentIndex);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  // Entrance animation: set initial off-screen position before browser paints
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const enterDir = sessionStorage.getItem('swipe-enter');
    if (!enterDir) return;
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

    const handleTouchStart = (e: TouchEvent) => {
      if (navigated || !e.touches[0]) return;
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

          if (nextIdx < 0 || nextIdx >= SWIPE_PAGES.length) {
            state = { ...IDLE_STATE };
            return;
          }
          if (isModalOpen() || hasHorizontalScroll(state.target)) {
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

        if (nextIdx >= 0 && nextIdx < SWIPE_PAGES.length) {
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
            router.push(SWIPE_PAGES[nextIdx].href);
          };
          content.addEventListener('transitionend', onEnd, { once: true });
          setTimeout(onEnd, ANIMATION_MS + 50);
          return;
        }
      }

      // Snap back
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

    content.addEventListener('touchstart', handleTouchStart, { passive: true });
    content.addEventListener('touchmove', handleTouchMove, { passive: false });
    content.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      content.removeEventListener('touchstart', handleTouchStart);
      content.removeEventListener('touchmove', handleTouchMove);
      content.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isSwipePage, router, pathname]);

  return {
    contentRef,
    currentIndex,
    totalPages: SWIPE_PAGES.length,
    isSwipePage,
  };
}
