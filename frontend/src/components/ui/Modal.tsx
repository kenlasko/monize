'use client';

import { ReactNode, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

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
}: ModalProps) {
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

  return createPortal(
    <div
      className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      onClick={() => attemptClose('backdrop')}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 ${maxWidthClasses[maxWidth]} w-full max-h-[90vh] ${allowOverflow ? 'overflow-visible' : 'overflow-y-auto'} outline-none ${className}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
