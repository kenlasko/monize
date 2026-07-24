'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import {
  computeTooltipPosition,
  type Rect,
  type Size,
} from '@/lib/tours/positioning';
import type { TourPlacement } from '@/lib/tours/types';

export interface TourTooltipLabels {
  next: string;
  back: string;
  done: string;
  endTour: string;
  tryIt: string;
  skipStep: string;
}

interface TourTooltipProps {
  /** Anchor rect, or null for a centered card. */
  rect: Rect | null;
  placement?: TourPlacement;
  title: string;
  body: string;
  /** e.g. "2 of 10". */
  stepLabel: string;
  /** Interactive steps show a "Try it" hint + "Skip this step" instead of Next. */
  interactive: boolean;
  /** Last step (or the skipped outro): the primary button is Done, not Next. */
  isLast: boolean;
  canBack: boolean;
  reducedMotion: boolean;
  /** In-form steps keep focus with the form rather than stealing it. */
  leaveFocusToForm: boolean;
  onNext: () => void;
  /** Primary action on the last step / skipped outro. */
  onDone: () => void;
  onBack: () => void;
  onSkip: () => void;
  onEnd: () => void;
  labels: TourTooltipLabels;
}

const MOBILE_QUERY = '(max-width: 639px)';

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

/**
 * The anchored (or centered) tour card. Positioned with the pure
 * `computeTooltipPosition` after measuring its own size on first paint, like
 * CalendarPopover. Not a `Modal` (its focus trap and scroll lock are wrong for
 * a walkthrough): on desktop it moves focus to itself on each passive step so
 * the controls are keyboard-reachable and `Modal` yields Esc/Tab to it; the
 * only exception is in-form steps, where focus stays with the form. On mobile
 * it renders as a fixed bottom sheet.
 */
export function TourTooltip({
  rect,
  placement = 'auto',
  title,
  body,
  stepLabel,
  interactive,
  isLast,
  canBack,
  reducedMotion,
  leaveFocusToForm,
  onNext,
  onDone,
  onBack,
  onSkip,
  onEnd,
  labels,
}: TourTooltipProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [size, setSize] = useState<Size | null>(null);

  // Measure the card after first paint so positioning can center/flip it.
  useEffect(() => {
    if (!cardRef.current) return;
    const el = cardRef.current;
    const raf = requestAnimationFrame(() => {
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    });
    return () => cancelAnimationFrame(raf);
  }, [title, body, isMobile]);

  // Move focus to the card on each step so its controls are keyboard-reachable
  // and Modal (which traps Tab) yields to us -- unless an in-form step asked us
  // to leave focus with the form.
  useEffect(() => {
    if (leaveFocusToForm || isMobile) return;
    const raf = requestAnimationFrame(() => cardRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [title, leaveFocusToForm, isMobile]);

  const primaryLabel = isLast ? labels.done : labels.next;

  const controls = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onEnd}
        className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        {labels.endTour}
      </button>
      <div className="flex items-center gap-2">
        {canBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            {labels.back}
          </Button>
        )}
        {interactive ? (
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {labels.skipStep}
          </button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={isLast ? onDone : onNext}
          >
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );

  const cardBody = (
    <>
      <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
        {stepLabel}
      </p>
      <h2 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{body}</p>
      {interactive && (
        <p className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {labels.tryIt}
        </p>
      )}
      {controls}
    </>
  );

  if (isMobile) {
    return createPortal(
      <div
        ref={cardRef}
        role="dialog"
        aria-live="polite"
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-[70] rounded-t-2xl border-t border-gray-200 bg-white p-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800"
      >
        {cardBody}
      </div>,
      document.body,
    );
  }

  const viewport = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  };
  const tooltipSize = size ?? { width: 320, height: 160 };

  let top: number;
  let left: number;
  if (rect) {
    const pos = computeTooltipPosition(rect, tooltipSize, viewport, placement);
    top = pos.top;
    left = pos.left;
  } else {
    top = Math.max(8, viewport.height / 2 - tooltipSize.height / 2);
    left = Math.max(8, viewport.width / 2 - tooltipSize.width / 2);
  }

  // Hide until measured to avoid a first-paint jump (visibility keeps it
  // measurable). Skip the fade for reduced-motion users.
  const measured = size !== null;
  const transition = reducedMotion ? '' : 'transition-opacity duration-150';

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-live="polite"
      tabIndex={-1}
      className={`fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded-lg border border-gray-200 bg-white p-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800 ${transition} ${
        measured ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ top, left }}
    >
      {cardBody}
    </div>,
    document.body,
  );
}
