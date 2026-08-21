'use client';

import { ReactNode, useEffect, useId, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HOVER_ROW_ON_CARD } from './Card';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';

// Tracks programmatic history.back() calls from modal cleanup.
// When a nested modal closes programmatically, it pops its history entry which fires popstate.
// Parent modals must skip that popstate to avoid cascading closes.
let pendingProgrammaticPops = 0;

// Tracks how many modals currently need body scroll locked.
// Only the last modal to close should restore body overflow.
let bodyOverflowLockCount = 0;

// Global stack of modal IDs that have pushed history entries.
// Only the topmost (last) modal should handle a popstate event.
// This is needed because createPortal renders child modals as siblings at document.body,
// so DOM-based nesting detection (querySelector) doesn't work.
const openModalStack: number[] = [];
let nextModalId = 0;

// Flag to prevent multiple modals from handling the same popstate event.
// Reset via microtask after each popstate dispatch cycle.
let popstateConsumed = false;

/** Reset module-level state for testing. Not for production use. */
export function __resetModalStateForTesting() {
  pendingProgrammaticPops = 0;
  bodyOverflowLockCount = 0;
  openModalStack.length = 0;
  nextModalId = 0;
  popstateConsumed = false;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface ModalProps {
  isOpen: boolean;
  onClose?: () => void;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl';
  className?: string;
  /** When true, pushes a browser history entry when the modal opens.
   *  Pressing the browser back button will close the modal instead of navigating away. */
  pushHistory?: boolean;
  /** Called before the modal closes (escape, backdrop, back button).
   *  Return false to prevent closing. Not called for programmatic close (parent sets isOpen=false). */
  onBeforeClose?: () => boolean | void;
  /** When true, uses overflow-visible instead of overflow-y-auto on the modal container.
   *  Useful when the modal contains dropdowns that need to expand beyond modal bounds. */
  allowOverflow?: boolean;
  /** Layout variant.
   *  - 'center' (default): centered rounded card, honours `maxWidth`.
   *  - 'drawer-left': full-height panel pinned to the left edge that slides in.
   *    Intended for mobile navigation. `maxWidth` is ignored in this variant. */
  variant?: 'center' | 'drawer-left';
  /** Raise the backdrop above the guided-tour overlay (spotlight z-[60]) so a
   *  modal opened mid-tour stays visible and interactive. Off by default; the
   *  ordinary z-50 backdrop sits *below* the tour overlay so in-form spotlight
   *  cutouts work. */
  elevated?: boolean;
  /** Heading for the dialog. Supplying it draws the standard header -- title,
   *  a close button, a rule under both -- and wires `aria-labelledby`, so the
   *  dialog announces itself by name instead of as an unlabelled region.
   *
   *  Every call site used to hand-roll this, which is how eight different
   *  heading treatments ended up in the tree for the same slot. */
  title?: ReactNode;
  /** Optional line under the title, wired to `aria-describedby`. */
  description?: ReactNode;
  /** Right-aligned action row along the bottom, above a rule. */
  footer?: ReactNode;
  /** Padding for the body.
   *
   *  Defaults to `none`, which is not a style choice: the 74 call sites that
   *  predate `title`/`footer` all pass their own padding through `className`,
   *  and a default would double it on every one of them. New call sites using
   *  `title` should pass `md`. */
  padding?: 'none' | 'md';
}

const maxWidthClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  '6xl': 'max-w-6xl',
};

export function Modal({
  isOpen,
  onClose,
  children,
  maxWidth = 'lg',
  className = '',
  pushHistory = false,
  onBeforeClose,
  allowOverflow = false,
  variant = 'center',
  elevated = false,
  title,
  description,
  footer,
  padding = 'none',
}: ModalProps) {
  const t = useTranslations('common');
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;
  // Track whether we have a history entry pushed
  const historyPushedRef = useRef(false);
  // Track whether the close was triggered by the browser back button (popstate)
  const closedByPopstateRef = useRef(false);
  // Unique ID for this modal instance in the global stack
  const modalIdRef = useRef(-1);
  // Focus trap refs
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Attempt to close — checks onBeforeClose before proceeding
  const attemptClose = useCallback((source: 'popstate' | 'escape' | 'backdrop') => {
    if (!onClose) return;

    if (onBeforeClose) {
      const result = onBeforeClose();
      if (result === false) {
        // Close was prevented — if this was from back button, re-push history
        if (source === 'popstate' && pushHistory) {
          window.history.pushState({ ...window.history.state, modal: true }, '');
          // historyPushedRef stays true
        }
        return;
      }
    }

    if (source === 'popstate') {
      closedByPopstateRef.current = true;
      // History entry already consumed by the browser
      historyPushedRef.current = false;
      // Remove from global stack
      const idx = openModalStack.indexOf(modalIdRef.current);
      if (idx !== -1) openModalStack.splice(idx, 1);
    }
    onClose();
  }, [onClose, onBeforeClose, pushHistory]);

  // Push history entry when modal opens, pop when it closes
  useEffect(() => {
    if (!pushHistory) return;

    if (isOpen && !historyPushedRef.current) {
      window.history.pushState({ ...window.history.state, modal: true }, '');
      historyPushedRef.current = true;
      closedByPopstateRef.current = false;
      // Register on global stack so only the topmost modal handles popstate
      modalIdRef.current = nextModalId++;
      openModalStack.push(modalIdRef.current);
    }

    if (!isOpen && historyPushedRef.current) {
      // Modal closed programmatically (save/cancel) — pop our history entry.
      // Signal other modals to ignore the resulting popstate event.
      historyPushedRef.current = false;
      // Remove from global stack
      const idx = openModalStack.indexOf(modalIdRef.current);
      if (idx !== -1) openModalStack.splice(idx, 1);
      pendingProgrammaticPops++;
      window.history.back();
    }

    if (!isOpen) {
      closedByPopstateRef.current = false;
    }
  }, [isOpen, pushHistory]);

  // Listen for popstate (browser back button)
  useEffect(() => {
    if (!isOpen || !pushHistory || !historyPushedRef.current) return;

    const handlePopstate = () => {
      // Skip popstate events caused by programmatic modal cleanup (not user back button)
      if (pendingProgrammaticPops > 0) {
        pendingProgrammaticPops--;
        return;
      }
      // Another modal already handled this popstate in the same event dispatch cycle
      if (popstateConsumed) return;
      if (historyPushedRef.current) {
        // Only the topmost modal on the stack should handle popstate.
        // This prevents parent modals from closing when a child modal's
        // back button is pressed (child modals render via portal as siblings,
        // not nested in DOM).
        const topModalId = openModalStack[openModalStack.length - 1];
        if (topModalId !== modalIdRef.current) {
          return;
        }
        // Mark as consumed so other modal handlers in this tick skip it
        popstateConsumed = true;
        queueMicrotask(() => { popstateConsumed = false; });
        attemptClose('popstate');
      }
    };

    window.addEventListener('popstate', handlePopstate);
    return () => window.removeEventListener('popstate', handlePopstate);
  }, [isOpen, pushHistory, attemptClose]);

  // Cleanup: if component unmounts while modal is open and history was pushed
  useEffect(() => {
    return () => {
      if (historyPushedRef.current) {
        historyPushedRef.current = false;
        const idx = openModalStack.indexOf(modalIdRef.current);
        if (idx !== -1) openModalStack.splice(idx, 1);
        pendingProgrammaticPops++;
        window.history.back();
      }
    };
  }, []);

  // Prevent body scroll when modal is open (ref-counted for stacked modals)
  useEffect(() => {
    if (isOpen) {
      bodyOverflowLockCount++;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (isOpen) {
        bodyOverflowLockCount--;
        if (bodyOverflowLockCount <= 0) {
          bodyOverflowLockCount = 0;
          document.body.style.overflow = '';
        }
      }
    };
  }, [isOpen]);

  // Auto-focus first focusable element on open; restore focus on close
  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement as HTMLElement;

    const frameId = requestAnimationFrame(() => {
      if (!modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusable.length > 0) {
        (focusable[0] as HTMLElement).focus();
      } else {
        modalRef.current.focus();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  // Handle keyboard: Escape to close, Tab/Shift+Tab to trap focus
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if focus is in a different modal (stacked or nested modals).
      // This prevents a parent modal from handling events meant for a child modal.
      if (modalRef.current) {
        const active = document.activeElement as HTMLElement | null;
        if (active) {
          const closestDialog = active.closest?.('[role="dialog"]');
          if (closestDialog && closestDialog !== modalRef.current) {
            return;
          }
        }
      }

      if (e.key === 'Escape' && onClose) {
        attemptClose('escape');
        return;
      }

      if (e.key === 'Tab' && modalRef.current) {
        const focusableElements = Array.from(
          modalRef.current.querySelectorAll(FOCUSABLE_SELECTOR),
        ) as HTMLElement[];

        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        const activeEl = document.activeElement;

        if (e.shiftKey) {
          if (activeEl === firstElement || !modalRef.current.contains(activeEl)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (activeEl === lastElement || !modalRef.current.contains(activeEl)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, attemptClose]);

  if (!isOpen) return null;

  const isDrawer = variant === 'drawer-left';

  // Backdrop alignment: drawer pins its panel to the left edge; the default
  // centers the card with padding.
  const backdropClassName = `fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm transition-opacity duration-200 ease-out opacity-100 starting:opacity-0 motion-reduce:transition-none ${
    elevated ? 'z-[65]' : 'z-50'
  } flex ${
    isDrawer
      ? 'justify-start'
      : 'items-center justify-center p-4'
  }`;

  // Panel shape. The drawer is a full-height left sheet that slides in from
  // off-screen via the CSS @starting-style (`starting:`) variant -- no extra
  // React state needed. The default keeps the centered rounded card.
  const overflowClass = allowOverflow ? 'overflow-visible' : 'overflow-y-auto';
  // The centered card fades and scales in from the same @starting-style
  // mechanism, so it arrives rather than appearing between two frames. There
  // is no exit animation: the panel unmounts on close, and holding it mounted
  // to animate out would mean tracking closing state through the stacked-modal
  // and popstate machinery for a few hundred milliseconds of polish.
  const panelClassName = isDrawer
    ? `bg-white dark:bg-gray-800 shadow-xl dark:shadow-gray-700/50 h-full w-[85%] max-w-sm ${overflowClass} outline-none transition-transform duration-200 ease-out translate-x-0 starting:-translate-x-full motion-reduce:transition-none ${className}`
    : `bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 ${maxWidthClasses[maxWidth]} w-full max-h-[90vh] ${overflowClass} outline-none transition duration-200 ease-out opacity-100 scale-100 starting:opacity-0 starting:scale-95 motion-reduce:transition-none ${className}`;

  return createPortal(
    <div
      className={backdropClassName}
      onClick={() => attemptClose('backdrop')}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={panelClassName}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-4 py-3 sm:px-6 dark:border-gray-700">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {description}
                </p>
              )}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={() => attemptClose('escape')}
                aria-label={t('close')}
                className={`-mr-1 shrink-0 rounded-md p-1 text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-200 ${HOVER_ROW_ON_CARD}`}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        {/* Bare children when nothing here asks for a body wrapper, so the 74
            call sites that predate these props render exactly the tree they
            did before -- several make the panel their own scroll or flex
            parent, which an unconditional div would break. */}
        {padding === 'md' ? <div className="p-4 sm:p-6">{children}</div> : children}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 sm:px-6 dark:border-gray-700">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
