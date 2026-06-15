'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '@/hooks/useClickOutside';
import { ActionIcon } from './ActionIcon';
import { TONE_SHEET_ICON_CLASS } from './actionTones';
import type { RowAction } from './rowAction';

export interface RowActionsOverflowProps {
  actions: RowAction[];
  /** Accessible label / tooltip for the kebab trigger. */
  label: string;
  /** Icon size class for the trigger glyph. */
  iconClass?: string;
}

/**
 * A "more actions" overflow menu (kebab) rendered in a portal. Generalizes the
 * former Transactions `CopyDropdown` so any list can fold extra row actions
 * behind a single trigger. Closes on outside-click or scroll.
 */
export function RowActionsOverflow({ actions, label, iconClass = 'w-4 h-4' }: RowActionsOverflowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.right });
    }
  }, []);

  useClickOutside([dropdownRef, buttonRef], () => setIsOpen(false), { enabled: isOpen });

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();
    const handleScroll = () => setIsOpen(false);
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [isOpen, updatePosition]);

  if (actions.length === 0) return null;

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setIsOpen((prev) => !prev); }}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 align-middle"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
        </svg>
      </button>
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          role="menu"
          className="fixed z-50 w-56 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black/5 dark:ring-white/10 py-1"
          style={{ top: dropdownPos.top, left: dropdownPos.left, transform: 'translateX(-100%)' }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={(e) => { e.stopPropagation(); setIsOpen(false); action.onClick(); }}
              className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ActionIcon name={action.icon} className={`w-4 h-4 shrink-0 ${TONE_SHEET_ICON_CLASS[action.tone]}`} />
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
