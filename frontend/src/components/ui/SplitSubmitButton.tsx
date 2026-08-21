'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { useClickOutside } from '@/hooks/useClickOutside';

/** One selectable behaviour for the form's submit button. */
export interface SubmitOption {
  /** Stable key, also used by tests; not shown. */
  id: string;
  /** The text the button shows while this option is the selected one. */
  label: string;
  /** One short line under the label in the menu, explaining what it does. */
  description?: string;
}

interface SplitSubmitButtonProps {
  options: readonly SubmitOption[];
  /** Id of the currently selected option; drives the button's label. */
  selectedId: string;
  /** Called when the user picks a different option from the menu. */
  onSelect: (id: string) => void;
  /** Accessible name for the chevron and its menu. */
  optionsLabel: string;
  isSubmitting?: boolean;
  disabled?: boolean;
}

/**
 * A submit button whose behaviour the user picks once and the form remembers.
 *
 * The wide half is an ordinary `type="submit"` -- clicking it (or pressing
 * Enter in the form) runs whichever behaviour is currently selected, so the
 * button acts on one click for everyone who never opens the menu. The narrow
 * chevron half is the only way to *change* the selection: it opens the list,
 * and choosing a row sets the button's behaviour without submitting, so a
 * click in the menu can never post a transaction the user was only reading
 * about.
 *
 * The two halves are siblings, not one nested in the other -- a control inside
 * a `<button>` truncates the click target and breaks hydration (see
 * `frontend/CLAUDE.md`). They are joined visually by squaring the facing
 * corners.
 */
export function SplitSubmitButton({
  options,
  selectedId,
  onSelect,
  optionsLabel,
  isSubmitting = false,
  disabled = false,
}: SplitSubmitButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(containerRef, close, { enabled: isOpen });

  // Escape closes the menu and nothing else. The listener is on `document` in
  // the *capture* phase so it runs before `Modal`'s own bubble-phase Escape
  // handler and can stop it: without this, dismissing the menu would also
  // close the form modal and take the half-entered transaction with it.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setIsOpen(false);
      chevronRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  const selected =
    options.find((option) => option.id === selectedId) ?? options[0];

  const handleSelect = (id: string) => {
    close();
    chevronRef.current?.focus();
    onSelect(id);
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <Button
        type="submit"
        isLoading={isSubmitting}
        disabled={disabled || isSubmitting}
        className="rounded-r-none"
      >
        {selected.label}
      </Button>
      <Button
        ref={chevronRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        disabled={disabled || isSubmitting}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={optionsLabel}
        className="rounded-l-none border-l border-blue-400 px-2 dark:border-blue-300"
      >
        <svg
          className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </Button>

      {isOpen && (
        <div
          role="menu"
          aria-label={optionsLabel}
          // Opens upward: this button sits at the bottom of a form modal, so a
          // downward menu would fall outside it.
          className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === selected.id}
              onClick={() => handleSelect(option.id)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors motion-reduce:transition-none hover:bg-gray-50 dark:hover:bg-gray-700 ${
                index === 0 ? 'rounded-t-md' : ''
              } ${index === options.length - 1 ? 'rounded-b-md' : ''}`}
            >
              <svg
                className={`mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400 ${
                  option.id === selected.id ? '' : 'invisible'
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {option.label}
                </span>
                {option.description && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
