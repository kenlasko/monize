'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { DragHandle } from '@/components/ui/DragHandle';
import {
  computeTooltipPosition,
  type Rect,
  type Size,
} from '@/lib/tours/positioning';
import type { TourPlacement } from '@/lib/tours/types';

/**
 * Render a tour string, emphasizing **bold** segments. Deliberately tiny -- the
 * only markup tour copy needs -- so bodies stay plain strings (no next-intl
 * rich text, and the `**` markers survive pseudo-locale generation untouched).
 */
function renderEmphasis(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? (
      <strong
        key={i}
        className="font-semibold text-gray-900 dark:text-gray-100"
      >
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export interface TourTooltipLabels {
  next: string;
  back: string;
  done: string;
  endTour: string;
  tryIt: string;
  skipStep: string;
  move: string;
}

/** Minimum gap kept between the card and the viewport edges. */
const EDGE = 8;

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
  /** Park an anchorless card in a bottom corner instead of centering it, so the
   *  page behind stays readable and usable. The corner is the right one unless
   *  `placement` is 'left'. Ignored when `rect` is set (anchored cards position
   *  against the anchor) and on mobile (where the card is an edge sheet
   *  already). */
  corner?: boolean;
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

/**
 * The viewport, as state. A centered or corner-parked card is positioned
 * against it, so a resize has to re-render the card -- reading
 * `window.innerWidth` during render alone would leave it stranded off-screen.
 */
function useViewportSize(): Size {
  const [viewport, setViewport] = useState<Size>(() => ({
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

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
 * it renders as a fixed sheet, flipped above a low anchor by the same placement
 * resolver so a short page's last control does not sit behind it.
 */
export function TourTooltip({
  rect,
  placement = 'auto',
  title,
  body,
  stepLabel,
  corner = false,
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
  const viewport = useViewportSize();
  const [size, setSize] = useState<Size | null>(null);
  // Where the user dragged the card, if they moved it. Null = auto-positioned.
  const [movedTo, setMovedTo] = useState<{ top: number; left: number } | null>(
    null,
  );
  // Where the card sat when the current drag started; the handle reports
  // offsets from the press, not absolute coordinates.
  const dragBase = useRef<{ top: number; left: number } | null>(null);

  // A manual position, and the measured size, belong to the step they were
  // taken on: the next step points at something else and its card is a
  // different height, so both reset ("info from previous render", never a
  // setState in an effect). Keeping a stale size would position the new card
  // from the old one's dimensions and then visibly jump once it re-measures.
  const stepKey = `${stepLabel}|${title}|${body}`;
  const [prevStepKey, setPrevStepKey] = useState(stepKey);
  if (stepKey !== prevStepKey) {
    setPrevStepKey(stepKey);
    setMovedTo(null);
    setSize(null);
  }

  // Measure the card after first paint so positioning can center/flip it. Also
  // after a resize: the card is `w-80 max-w-[calc(100vw-16px)]`, so a narrower
  // viewport re-wraps the body and changes the height that decides whether the
  // card sits above or below its anchor.
  useEffect(() => {
    if (!cardRef.current) return;
    const el = cardRef.current;
    const raf = requestAnimationFrame(() => {
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    });
    return () => cancelAnimationFrame(raf);
  }, [stepKey, isMobile, viewport]);

  // Move focus to the card on each step so its controls are keyboard-reachable
  // and Modal (which traps Tab) yields to us -- unless an in-form step asked us
  // to leave focus with the form.
  useEffect(() => {
    if (leaveFocusToForm || isMobile) return;
    const raf = requestAnimationFrame(() => cardRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [stepKey, leaveFocusToForm, isMobile]);

  const primaryLabel = isLast ? labels.done : labels.next;

  // Secondary actions read as links, not as disabled-looking grey text: they
  // are the only way out of a step, so they have to look clickable.
  const linkClass =
    'rounded text-xs font-medium text-gray-600 underline decoration-gray-400 decoration-dotted underline-offset-2 hover:text-gray-900 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:decoration-gray-500 dark:hover:text-white';

  const controls = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <button type="button" onClick={onEnd} className={linkClass}>
        {labels.endTour}
      </button>
      <div className="flex items-center gap-2">
        {canBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            {labels.back}
          </Button>
        )}
        {interactive ? (
          <button type="button" onClick={onSkip} className={linkClass}>
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
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        {renderEmphasis(body)}
      </p>
      {interactive && (
        <p className="mt-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          {labels.tryIt}
        </p>
      )}
      {controls}
    </>
  );

  const tooltipSize = size ?? { width: 320, height: 160 };

  if (isMobile) {
    const atTop =
      rect !== null &&
      computeTooltipPosition(rect, tooltipSize, viewport).placement === 'top';
    return createPortal(
      <div
        ref={cardRef}
        role="dialog"
        aria-live="polite"
        tabIndex={-1}
        className={`fixed inset-x-0 z-[70] border-gray-200 bg-white p-4 shadow-xl outline-none dark:border-gray-700 dark:bg-gray-800 ${
          atTop ? 'top-0 rounded-b-2xl border-b' : 'bottom-0 rounded-t-2xl border-t'
        }`}
      >
        {cardBody}
      </div>,
      document.body,
    );
  }

  let top: number;
  let left: number;
  if (rect) {
    const pos = computeTooltipPosition(rect, tooltipSize, viewport, placement);
    top = pos.top;
    left = pos.left;
  } else if (corner) {
    // Parked in a bottom corner so the page stays readable and usable behind
    // it. Right by default; `placement: 'left'` moves it to the other side for
    // a step that asks the user to use a control the right of the page holds --
    // row actions are right-aligned and sticky, so a right-parked card lands on
    // the very button such a step names (CI caught the account-detail step's
    // card intercepting the click on Details at a 720px-tall viewport).
    top = Math.max(8, viewport.height - tooltipSize.height - 16);
    left =
      placement === 'left'
        ? 16
        : Math.max(8, viewport.width - tooltipSize.width - 16);
  } else {
    top = Math.max(8, viewport.height / 2 - tooltipSize.height / 2);
    left = Math.max(8, viewport.width / 2 - tooltipSize.width / 2);
  }

  // A step's auto-position can still land over the very thing the user needs
  // (an account row, say), so the card is movable. Once moved, the user's
  // position wins for the rest of the step.
  const clampToViewport = (nextTop: number, nextLeft: number) => ({
    top: Math.min(
      Math.max(EDGE, nextTop),
      Math.max(EDGE, viewport.height - tooltipSize.height - EDGE),
    ),
    left: Math.min(
      Math.max(EDGE, nextLeft),
      Math.max(EDGE, viewport.width - tooltipSize.width - EDGE),
    ),
  });

  // Clamped on every render, not just while dragging: a window narrowed after
  // the user parked the card would otherwise leave it off-screen for the rest
  // of the step, with no handle left to drag it back.
  const moved = movedTo ? clampToViewport(movedTo.top, movedTo.left) : null;
  const shownTop = moved ? moved.top : top;
  const shownLeft = moved ? moved.left : left;

  const dragTo = (dx: number, dy: number) => {
    const base = dragBase.current;
    if (!base) return;
    setMovedTo(clampToViewport(base.top + dy, base.left + dx));
  };

  // Hide until measured to avoid a first-paint jump (visibility keeps it
  // measurable). Skip the fade for reduced-motion users.
  const measured = size !== null;
  // Suppress the fade while dragging so the card tracks the pointer exactly.
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
      style={{ top: shownTop, left: shownLeft }}
    >
      <DragHandle
        label={labels.move}
        className="absolute right-1.5 top-1.5"
        onDragStart={() => {
          dragBase.current = { top: shownTop, left: shownLeft };
        }}
        onDragMove={dragTo}
        onNudge={(dx, dy) =>
          setMovedTo(clampToViewport(shownTop + dy, shownLeft + dx))
        }
      />
      {cardBody}
    </div>,
    document.body,
  );
}
