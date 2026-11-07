'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS } from '@/components/ui/interactive-row';
import { LIST_TOOLBAR_BUTTON_CLASS } from '@/components/ui/ListTopToolbar';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { MENU_ENTER_CLASS, MENU_ORIGIN_RIGHT } from '@/components/ui/menu-motion';

/** One hideable column, with the label its header shows. */
export interface ColumnChooserItem<C extends string> {
  id: C;
  label: string;
}

interface ColumnChooserMenuProps<C extends string> {
  /** The table's hideable columns, in display order. Structural ones are never listed. */
  columns: readonly ColumnChooserItem<C>[];
  /** The columns currently hidden (`useHiddenColumns(...).hidden`). */
  hidden: ReadonlySet<C>;
  onHide: (id: C) => void;
  onShow: (id: C) => void;
  onShowAll: () => void;
}

const ITEM_CLASS =
  `w-full px-3 py-2 flex items-center gap-2 text-left text-sm text-gray-700 dark:text-gray-300 ${HOVER_ROW_ON_CARD} ` +
  `${INTERACTIVE_ROW_FOCUS_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`;

/** The menu's rows that can take focus, in order ("Show all" only while enabled). */
function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
}

function focusEdge(menu: HTMLElement | null, edge: 'first' | 'last') {
  const items = enabledItems(menu);
  items[edge === 'first' ? 0 : items.length - 1]?.focus();
}

/**
 * The "Columns" menu in a list's toolbar: one checkbox row per hideable column,
 * then "Show all". It is the one way to bring a hidden column back (a header's
 * long-press only hides), so the trigger carries the count of hidden columns.
 * A checkbox row keeps the menu open, so several columns can be toggled in one
 * visit; "Show all" is a plain action and closes it, focus returning to the
 * trigger.
 *
 * Opening, Escape and click-outside behave as `ActionMenu` does, focus going
 * back to the trigger on Escape. ArrowDown or ArrowUp on the trigger opens the
 * menu (if it is shut) and moves into its first or last row; inside, the arrow
 * keys, Home and End move between the rows.
 */
export function ColumnChooserMenu<C extends string>({
  columns,
  hidden,
  onHide,
  onShow,
  onShowAll,
}: ColumnChooserMenuProps<C>) {
  const t = useTranslations('common');
  const { formatNumber } = useNumberFormat();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The row to focus once the menu has rendered, when an arrow key opened it. */
  const pendingFocus = useRef<'first' | 'last' | null>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useClickOutside(containerRef, close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  const showAll = () => {
    close();
    triggerRef.current?.focus();
    onShowAll();
  };

  const hiddenCount = columns.filter((column) => hidden.has(column.id)).length;
  const formattedCount = formatNumber(hiddenCount, 0);

  useEffect(() => {
    if (!isOpen || pendingFocus.current === null) return;
    focusEdge(menuRef.current, pendingFocus.current);
    pendingFocus.current = null;
  }, [isOpen]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const edge = event.key === 'ArrowDown' ? 'first' : 'last';
    if (isOpen) {
      focusEdge(menuRef.current, edge);
    } else {
      pendingFocus.current = edge;
      setIsOpen(true);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems(menuRef.current);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === 'ArrowUp')
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={
          hiddenCount > 0
            ? t('columns.buttonWithHidden', { count: formattedCount })
            : t('columns.button')
        }
        title={t('columns.menuLabel')}
        className={LIST_TOOLBAR_BUTTON_CLASS}
      >
        <svg
          className="w-4 h-4 sm:mr-1"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 4v16m6-16v16M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z"
          />
        </svg>
        <span className="hidden sm:inline">{t('columns.button')}</span>
        {hiddenCount > 0 && (
          <span
            data-testid="column-chooser-count"
            aria-hidden="true"
            className="ml-1 tabular-nums font-semibold text-blue-600 dark:text-blue-400"
          >
            {formattedCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('columns.menuLabel')}
          onKeyDown={handleMenuKeyDown}
          className={`absolute right-0 mt-1 w-56 max-sm:fixed max-sm:inset-x-2 max-sm:w-auto py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 ${MENU_ENTER_CLASS} ${MENU_ORIGIN_RIGHT}`}
        >
          {columns.map((column) => {
            const visible = !hidden.has(column.id);
            return (
              <button
                key={column.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={visible}
                onClick={() => (visible ? onHide(column.id) : onShow(column.id))}
                className={ITEM_CLASS}
              >
                <svg
                  className={`w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400 ${visible ? '' : 'invisible'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {column.label}
              </button>
            );
          })}
          <div role="separator" className="my-1 border-t border-gray-200 dark:border-gray-700" />
          <button
            type="button"
            role="menuitem"
            disabled={hiddenCount === 0}
            onClick={showAll}
            className={ITEM_CLASS}
          >
            <span className="w-4 h-4 shrink-0" aria-hidden="true" />
            {t('columns.showAll')}
          </button>
        </div>
      )}
    </div>
  );
}
