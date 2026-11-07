'use client';

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { HelpLink } from '@/components/help/HelpLink';
import type { DocsLink } from '@/lib/docs-links';

interface InfoTooltipProps {
  /** Tooltip body text. Shown in the popover and exposed via aria-label. */
  text: string;
  /** Where the popover renders relative to the icon. Defaults to 'bottom'. */
  placement?: 'top' | 'bottom';
  /**
   * Horizontal edge the popover anchors to. Use 'right' (opens leftward) when
   * the icon sits near a container's right edge -- e.g. the right column of a
   * modal -- so the fixed-width popover doesn't overflow and get clipped.
   * Defaults to the natural alignment for the placement (left for 'bottom',
   * centered for 'top').
   */
  align?: 'left' | 'right';
  /** Tailwind size classes for the icon. Defaults to 'h-4 w-4'. */
  iconClassName?: string;
  /**
   * Render the popover in a fixed-position portal on document.body so it
   * escapes ancestors that clip overflow (e.g. a scrollable card). The
   * position is clamped to the viewport so it never gets cut off.
   */
  usePortal?: boolean;
  /**
   * Where the guide explains this further, a key of `DOCS_LINKS`. Adds a
   * "Learn more" link under the text that opens the help panel there and
   * closes the popover. The link renders beside the text's `<button>`
   * trigger, never inside it -- an `<a>` nested in a `<button>` is invalid
   * and the parser would truncate the trigger's own content model.
   */
  learnMore?: DocsLink;
}

const POPOVER_WIDTH = 256; // matches w-64
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

interface Rect {
  top: number;
  bottom: number;
  left: number;
}

interface Size {
  width: number;
  height: number;
}

/**
 * Where a fixed-position popover goes: beside the anchor on the requested
 * side, flipped to the other side when only that one fits, and clamped inside
 * the viewport on both axes. Pure so the clamp is testable without a layout
 * engine.
 */
export function placePopover(
  anchor: Rect,
  popover: Size,
  placement: 'top' | 'bottom',
  viewport: Size,
): { top: number; left: number } {
  const maxLeft = viewport.width - popover.width - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, maxLeft));

  const above = anchor.top - ANCHOR_GAP - popover.height;
  const below = anchor.bottom + ANCHOR_GAP;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  const fitsBelow = below + popover.height <= viewport.height - VIEWPORT_MARGIN;
  let top: number;
  if (placement === 'top') {
    top = fitsAbove || !fitsBelow ? above : below;
  } else {
    top = fitsBelow || !fitsAbove ? below : above;
  }
  const maxTop = viewport.height - popover.height - VIEWPORT_MARGIN;
  return { top: Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop)), left };
}

/** How the reader opened the help and pinned it open, if they did. */
type Pinned = 'inline' | 'portal' | null;

/**
 * Inline help icon: the one way this app explains a figure or a setting.
 *
 * It is available on every device. A mouse hovers it, a keyboard focuses it,
 * and a click, a tap or Enter pins the same popover open until the reader taps
 * or clicks outside it, taps it again, or presses Escape. A hover popover alone
 * has no touch trigger, so the icon used to be hidden below `md` and phones got
 * none of the explanations -- the invariant now is that help a desktop reader
 * can see, a touch reader can open.
 *
 * The trigger is a `<button>`, not a focusable `<span>`. A span's implicit role
 * is generic, which screen readers do not announce and whose `aria-label` they
 * therefore drop -- so a `tabIndex` on one produces a tab stop that says
 * nothing, repeated wherever this component appears. The button carries the
 * text as its label, so a screen reader reads the help without opening it; no
 * native title attribute is used so the browser tooltip doesn't duplicate the
 * styled popover. Its hit area extends past the small icon so a finger can
 * find it.
 *
 * A tap-opened popover always goes through the viewport-clamped portal: the
 * inline one is positioned for a desktop column and runs off a phone's edge.
 *
 * Escape dismisses the popover without moving focus, per WCAG 1.4.13.
 */
export function InfoTooltip({
  text,
  placement = 'bottom',
  align,
  iconClassName = 'h-4 w-4',
  usePortal = false,
  learnMore,
}: InfoTooltipProps) {
  const t = useTranslations('help');
  const iconRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  /** The CSS-driven (non-portal) popover, so a press on its Learn More link is not mistaken for an outside press. */
  const inlinePopoverRef = useRef<HTMLSpanElement>(null);
  /** The pointer that pressed the trigger, read by the click that follows. */
  const pressedWith = useRef<string | null>(null);
  /** Closes the transient (hover) portal popover, delayed so a mouse crossing the gap to its Learn More link doesn't lose it first. */
  const transientCloseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pinned, setPinned] = useState<Pinned>(null);
  /** Hover or keyboard focus, for the portal variant (the inline one uses CSS). */
  const [transient, setTransient] = useState(false);
  /** Only used by the CSS-driven variant, whose hover popover has no state of its own. */
  const [dismissed, setDismissed] = useState(false);

  const portalShown = usePortal ? pinned !== null || transient : pinned === 'portal';
  const showing = usePortal ? portalShown : pinned !== null || !dismissed;

  const close = useCallback(() => {
    if (transientCloseTimeout.current) {
      clearTimeout(transientCloseTimeout.current);
      transientCloseTimeout.current = null;
    }
    setPinned(null);
    setTransient(false);
    setDismissed(true);
  }, []);

  useEffect(() => {
    return () => {
      if (transientCloseTimeout.current) clearTimeout(transientCloseTimeout.current);
    };
  }, []);

  const cancelTransientClose = useCallback(() => {
    if (transientCloseTimeout.current) {
      clearTimeout(transientCloseTimeout.current);
      transientCloseTimeout.current = null;
    }
  }, []);

  // A mouse crossing the gap from the trigger to the popover's Learn More
  // link briefly leaves both elements. Closing immediately on that gap would
  // make the link unreachable by hover, so the close is delayed just long
  // enough for the pointer to land back inside (the trigger, by re-entering
  // it, or the popover itself via its own pointerenter) and cancel it.
  const scheduleTransientClose = useCallback(() => {
    if (!learnMore) {
      setTransient(false);
      return;
    }
    cancelTransientClose();
    transientCloseTimeout.current = setTimeout(() => setTransient(false), 150);
  }, [learnMore, cancelTransientClose]);

  // Measured before paint, and again whenever the page under it moves: a pinned
  // popover outlives the scroll or the phone keyboard that shifts its anchor.
  useLayoutEffect(() => {
    if (!portalShown) return;
    const place = () => {
      const anchor = iconRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const { top, left } = placePopover(
        anchor.getBoundingClientRect(),
        { width: popover.offsetWidth || POPOVER_WIDTH, height: popover.offsetHeight },
        placement,
        { width: window.innerWidth, height: window.innerHeight },
      );
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [portalShown, placement]);

  // A pinned popover closes when the reader presses anywhere else. Captured on
  // the document so a control that stops propagation cannot keep it open.
  useEffect(() => {
    if (pinned === null) return;
    const onPress = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (target && iconRef.current?.contains(target)) return;
      if (target && popoverRef.current?.contains(target)) return;
      if (target && inlinePopoverRef.current?.contains(target)) return;
      setPinned(null);
      setTransient(false);
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => document.removeEventListener('pointerdown', onPress, true);
  }, [pinned]);

  /**
   * Escape closes the help without taking focus away from the trigger.
   *
   * The key is claimed only while a popover is actually up. `Modal` closes on a
   * document-level keydown listener, which a stopped event never reaches, so
   * stopping propagation unconditionally ate every Escape after the first for
   * as long as a tooltip trigger held focus -- one dismissed the tooltip
   * (correct, WCAG 1.4.13) and the modal around it could then not be closed
   * from the keyboard at all. With nothing showing, this component has no claim
   * on the key and lets it through.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    if (!showing) return;
    event.stopPropagation();
    close();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    pressedWith.current = event.pointerType || 'mouse';
  };

  // Attached to the wrapper, not the button, so a click reaches it whether it
  // started on the trigger or (via React's tree-based bubbling, portal and
  // all) on the popover -- a tap on an open popover closes it the same way a
  // tap on the trigger itself does.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    // A help icon acts on itself. Inside a clickable row or card the click
    // would otherwise bubble and navigate away from the thing being explained
    // -- the same rule the row's other inner controls follow.
    event.stopPropagation();
    const byTouch = pressedWith.current === 'touch' || pressedWith.current === 'pen';
    pressedWith.current = null;
    if (pinned !== null) {
      close();
      return;
    }
    setDismissed(false);
    setPinned(usePortal || byTouch ? 'portal' : 'inline');
  };

  // Hover belongs to a mouse. A phone emulates `mouseenter` on a tap, which
  // would open the popover a moment before the tap's own click toggled it.
  const onPointerEnter = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    cancelTransientClose();
    setDismissed(false);
    if (usePortal) setTransient(true);
  };

  const onPointerLeave = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    scheduleTransientClose();
  };

  // Focus that a press produced is the press's business: the click decides.
  // Only focus that arrived without one (the keyboard) shows the help.
  const onFocus = () => {
    setDismissed(false);
    if (usePortal && pressedWith.current === null) setTransient(true);
  };

  // Focus moving to another control closes a pinned popover, so a keyboard
  // reader who pinned it does not leave it behind. A tap on empty page moves
  // focus nowhere (no `relatedTarget`) and is the outside press's to handle; the
  // press that started it is forgotten either way.
  const onBlur = (event: FocusEvent<HTMLButtonElement>) => {
    pressedWith.current = null;
    setTransient(false);
    const next = event.relatedTarget;
    const movedIntoPopover =
      next !== null &&
      (popoverRef.current?.contains(next) || inlinePopoverRef.current?.contains(next));
    if (next && !movedIntoPopover) setPinned(null);
  };

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  const popoverBody =
    'whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg';

  const learnMoreLink = learnMore && (
    <HelpLink
      link={learnMore}
      onClick={close}
      className="mt-1 block font-medium text-blue-300 hover:text-blue-100 underline"
    >
      {t('learnMore')}
    </HelpLink>
  );

  // Mouse-only: a tap keeps the popover open through `pinned`, not `transient`.
  const onPortalPopoverPointerEnter = () => cancelTransientClose();
  const onPortalPopoverPointerLeave = () => scheduleTransientClose();

  const portal =
    portalShown &&
    createPortal(
      <span
        ref={popoverRef}
        role="tooltip"
        style={{
          position: 'fixed',
          width: POPOVER_WIDTH,
          maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        }}
        onPointerEnter={onPortalPopoverPointerEnter}
        onPointerLeave={onPortalPopoverPointerLeave}
        // A pinned popover (or one carrying a Learn More link, reachable only
        // with pointer events enabled) takes the tap or click that lands on
        // it instead of letting it fall through to whatever row lies
        // underneath.
        className={`${pinned === null && !learnMore ? 'pointer-events-none' : 'cursor-pointer'} z-50 ${popoverBody}`}
      >
        {text}
        {learnMoreLink}
      </span>,
      document.body,
    );

  const inlineVisibility =
    usePortal || pinned === 'portal' || dismissed
      ? 'hidden'
      : pinned === 'inline'
        ? 'block'
        : 'hidden group-hover/tip:block group-focus-within/tip:block';

  const vertical = placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-1';
  const horizontal =
    align === 'right'
      ? 'right-0'
      : align === 'left'
        ? 'left-0'
        : placement === 'top'
          ? 'left-1/2 -translate-x-1/2'
          : 'left-0';

  return (
    // The hover/focus group lives on this wrapper, not the button: the
    // popover is a sibling of the button (never its child), because an `<a>`
    // -- the Learn More link -- is invalid content inside a `<button>`.
    // `group-hover`/`group-focus-within` bubble from whichever of the two is
    // actually under the pointer or holds focus, so hovering or tabbing into
    // the popover itself keeps it open.
    <span className="group/tip relative inline-flex items-center align-middle ml-1" onClick={onClick}>
      <button
        type="button"
        ref={iconRef}
        aria-label={text}
        aria-expanded={pinned !== null}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        // A press on the icon is not the start of a press on the row around it
        // (`useLongPress` arms its long-press timer on these).
        onMouseDown={stop}
        onTouchStart={stop}
        onContextMenu={stop}
        className="relative inline-flex items-center text-gray-400 hover:text-blue-500 focus-visible:text-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded transition-colors motion-reduce:transition-none cursor-help before:absolute before:-inset-2.5"
      >
        <QuestionMarkCircleIcon className={iconClassName} aria-hidden="true" />
      </button>
      {!usePortal && (
        <span
          ref={inlinePopoverRef}
          role="tooltip"
          className={`${learnMore ? '' : 'pointer-events-none'} ${inlineVisibility} absolute z-20 w-64 ${popoverBody} ${horizontal} ${vertical}`}
        >
          {text}
          {learnMoreLink}
        </span>
      )}
      {portal}
    </span>
  );
}
