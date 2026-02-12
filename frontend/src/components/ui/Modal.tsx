'use client';

import { ReactNode, useEffect, useRef, useCallback } from 'react';

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
}: ModalProps) {
  // Track whether we have a history entry pushed
  const historyPushedRef = useRef(false);
  // Track whether the close was triggered by the browser back button (popstate)
  const closedByPopstateRef = useRef(false);

  // Attempt to close — checks onBeforeClose before proceeding
  const attemptClose = useCallback((source: 'popstate' | 'escape' | 'backdrop') => {
    if (!onClose) return;

    if (onBeforeClose) {
      const result = onBeforeClose();
      if (result === false) {
        // Close was prevented — if this was from back button, re-push history
        if (source === 'popstate' && pushHistory) {
          window.history.pushState({ modal: true }, '');
          // historyPushedRef stays true
        }
        return;
      }
    }

    if (source === 'popstate') {
      closedByPopstateRef.current = true;
      // History entry already consumed by the browser
      historyPushedRef.current = false;
    }
    onClose();
  }, [onClose, onBeforeClose, pushHistory]);

  // Push history entry when modal opens, pop when it closes
  useEffect(() => {
    if (!pushHistory) return;

    if (isOpen && !historyPushedRef.current) {
      window.history.pushState({ modal: true }, '');
      historyPushedRef.current = true;
      closedByPopstateRef.current = false;
    }

    if (!isOpen && historyPushedRef.current) {
      // Modal closed programmatically (save/cancel) — pop our history entry
      historyPushedRef.current = false;
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
      if (historyPushedRef.current) {
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
        window.history.back();
      }
    };
  }, []);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Handle escape key — route through attemptClose
  useEffect(() => {
    if (!isOpen || !onClose) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        attemptClose('escape');
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, attemptClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      onClick={() => attemptClose('backdrop')}
    >
      <div
        className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 ${maxWidthClasses[maxWidth]} w-full max-h-[90vh] overflow-y-auto ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
