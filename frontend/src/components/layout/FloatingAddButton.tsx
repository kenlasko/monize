'use client';

import { useCallback, useRef, useState } from 'react';
import { useClickOutside } from '@/hooks/useClickOutside';
import { RoundAddButton } from '@/components/ui/RoundAddButton';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { useMobileAddActionStore } from '@/store/mobileAddActionStore';

const MENU_ITEM_CLASS = `${HOVER_ROW_ON_CARD} w-full px-4 py-2 text-left text-sm text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:text-gray-300`;

/**
 * The "+" a desktop's pinned page bar carries: the very action the page
 * registered for the mobile tab bar's add button (`useMobileAddAction`), so
 * the two can never offer different things. A page whose "new" button is a
 * menu (`useMobileAddChoices`) gets the same choices as a small menu under
 * the button. A page that registered nothing draws no button.
 */
export function FloatingAddButton() {
  const action = useMobileAddActionStore((s) => s.action);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useClickOutside(containerRef, close, {
    enabled: open,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  if (!action) return null;
  const choices = action.choices?.() ?? null;

  if (!choices) {
    return <RoundAddButton label={action.label} onClick={action.run} />;
  }

  return (
    <div ref={containerRef} className="relative">
      <RoundAddButton
        ref={triggerRef}
        label={action.label}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="true"
        aria-expanded={open}
      />
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              onClick={() => {
                close();
                choice.run();
              }}
              className={MENU_ITEM_CLASS}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
