import { useEffect, useState } from 'react';
import type { Rect } from '@/lib/tours/positioning';

function toRect(domRect: DOMRect): Rect {
  return {
    top: domRect.top,
    left: domRect.left,
    width: domRect.width,
    height: domRect.height,
  };
}

/**
 * Track the live viewport rect of an element, updating on resize and on
 * scroll/window-resize (rAF-throttled so a scroll never floods layout work).
 * Returns null when there is no element (e.g. a centered tour step).
 */
export function useAnchorRect(element: HTMLElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  // Drop the previous element's rect immediately when the target changes.
  const [prevElement, setPrevElement] = useState(element);
  if (element !== prevElement) {
    setPrevElement(element);
    setRect(null);
  }

  useEffect(() => {
    if (!element) return;

    let raf = 0;
    const measure = () => setRect(toRect(element.getBoundingClientRect()));
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [element]);

  return rect;
}
