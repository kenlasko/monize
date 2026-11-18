'use client';

import { useEffect, useRef } from 'react';
import {
  DECISION_THRESHOLD,
  COMMIT_THRESHOLD_RATIO,
  VELOCITY_THRESHOLD,
  SWIPE_ANIMATION_MS as ANIMATION_MS,
  hasHorizontalScroll,
  isModalOpen,
} from './swipe-gesture';

// A horizontal finger swipe on a paged list turns its page in place: swipe
// left for the next page, right for the previous one, so the reader never has
// to scroll to the pager to move through a long register. The gesture core is
// the same as `useSwipeNavigation` (shared in `swipe-gesture.ts`); the
// difference is that committing calls back with a page number instead of
// navigating, and the animation slides the list content within its own box
// rather than sliding a whole view off-screen.

interface UseSwipeToPaginateArgs {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

interface UseSwipeToPaginateReturn {
  // Attach to the element wrapping the paged content. It is translated during
  // the drag and slid out on commit.
  swipeRef: React.RefObject<HTMLDivElement | null>;
  // Whether the list has more than one page, so a swipe has somewhere to go.
  // The caller marks the zone with `SWIPE_PAGINATE_ATTR` only when this is
  // true, so a single-page list still yields the swipe to view navigation.
  paginates: boolean;
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

export function useSwipeToPaginate({
  page,
  totalPages,
  onPageChange,
}: UseSwipeToPaginateArgs): UseSwipeToPaginateReturn {
  const swipeRef = useRef<HTMLDivElement>(null);
  const paginates = totalPages > 1;

  // The listener closures read these through refs so a page change does not
  // re-attach the listeners, and mid-gesture reads see the current bounds.
  const pageRef = useRef(page);
  const totalPagesRef = useRef(totalPages);
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    pageRef.current = page;
    totalPagesRef.current = totalPages;
    onPageChangeRef.current = onPageChange;
  }, [page, totalPages, onPageChange]);

  useEffect(() => {
    const content = swipeRef.current;
    if (!content || !paginates) return;

    let state: TouchState = { ...IDLE_STATE };
    let navigated = false;

    const resetStyles = () => {
      content.style.transition = '';
      content.style.transform = '';
      content.style.opacity = '';
      content.style.willChange = '';
    };

    // The page the given horizontal delta would move to, or null when there is
    // no page in that direction (page 1 swiping right, last page swiping left).
    const targetPageFor = (deltaX: number): number | null => {
      const dir = deltaX < 0 ? 1 : -1;
      const next = pageRef.current + dir;
      if (next < 1 || next > totalPagesRef.current) return null;
      return next;
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

    // Drop the gesture without turning the page. A drag already under way
    // slides back, so the list is never left sitting part way across its box.
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
      if (content.style.transition) return; // an animation is in progress

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
          // Horizontal gesture -- only act if there is a page to turn to and
          // nothing else owns the horizontal drag (a scrollable cell, a modal).
          if (targetPageFor(deltaX) === null) {
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
          // Vertical scroll -- not ours.
          state = { ...IDLE_STATE };
          return;
        }
      }

      if (state.phase === 'swiping') {
        e.preventDefault();
        const width = content.offsetWidth || window.innerWidth;
        const clamped = Math.max(-width, Math.min(width, deltaX));
        const opacity = 1 - (Math.abs(clamped) / width) * 0.3;
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
      const width = content.offsetWidth || window.innerWidth;

      const shouldCommit = absX > width * COMMIT_THRESHOLD_RATIO || velocity > VELOCITY_THRESHOLD;
      state = { ...IDLE_STATE };

      const nextPage = shouldCommit ? targetPageFor(deltaX) : null;

      if (nextPage !== null) {
        navigated = true;
        const targetX = deltaX < 0 ? -width : width;
        content.style.transition = `transform ${ANIMATION_MS}ms ease-out, opacity ${ANIMATION_MS}ms ease-out`;
        content.style.transform = `translateX(${targetX}px)`;
        content.style.opacity = '0.7';

        let done = false;
        const onEnd = () => {
          if (done) return;
          done = true;
          content.removeEventListener('transitionend', onEnd);
          // The rows for the new page render in place, so clear the slide and
          // let them appear at rest -- there is no route change to animate in.
          resetStyles();
          navigated = false;
          onPageChangeRef.current(nextPage);
        };
        content.addEventListener('transitionend', onEnd, { once: true });
        setTimeout(onEnd, ANIMATION_MS + 50);
        return;
      }

      snapBack();
    };

    // The browser or the OS took the touch away mid-gesture (Android's edge
    // Back gesture, the notification shade). No touchend follows, so without
    // this the drag's offset would stay on the list.
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
  }, [paginates]);

  return { swipeRef, paginates };
}
