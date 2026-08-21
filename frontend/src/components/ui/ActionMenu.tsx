'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useClickOutside } from '@/hooks/useClickOutside';

/** One row in the menu. A disabled item stays listed but cannot be chosen. */
export interface ActionMenuItem {
  /** Stable key, also used by tests; not shown. */
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface ActionMenuProps {
  /** Trigger label, e.g. "Maintenance". */
  label: string;
  items: readonly ActionMenuItem[];
  /** Trigger variant; the default keeps it behind the page's primary action. */
  variant?: 'outline' | 'primary' | 'secondary';
  /** Extra classes for the trigger. */
  className?: string;
}

// Menu-row styling, taken verbatim from NewReportButton/NewTransactionButton so
// the three menus in the app look the same until those two move onto this
// component.
const ITEM_CLASS =
  'w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 transition-colors motion-reduce:transition-none hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * A single header button that opens a short list of actions, for pages with
 * more secondary actions than a header can carry. The pattern already exists
 * twice (`NewReportButton`, `NewTransactionButton`), both grouping *what to
 * create*; this generalises it so a page can also group what to *do* -- the
 * four bulk maintenance actions on Payees being the first case.
 *
 * The trigger is the shared `Button`, so it carries the app's focus ring and
 * sizing; the menu closes on click-outside and on Escape, which returns focus
 * to the trigger. Full width below `sm`, matching how `PageHeader` stacks its
 * actions there.
 */
export function ActionMenu({
  label,
  items,
  variant = 'outline',
  className = '',
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(containerRef, close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  const handleSelect = (item: ActionMenuItem) => {
    close();
    item.onSelect();
  };

  return (
    <div
      ref={containerRef}
      className="relative block w-full sm:inline-block sm:w-auto"
    >
      <Button
        ref={triggerRef}
        variant={variant}
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={`w-full whitespace-nowrap sm:w-auto inline-flex items-center justify-center gap-1.5 ${className}`}
      >
        {label}
        <svg
          className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
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
          aria-label={label}
          className="absolute right-0 mt-1 w-full sm:w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50"
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => handleSelect(item)}
              className={`${ITEM_CLASS} ${index === 0 ? 'rounded-t-md' : ''} ${
                index === items.length - 1 ? 'rounded-b-md' : ''
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
