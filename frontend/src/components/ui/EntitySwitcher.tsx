'use client';

import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useClickOutside } from '@/hooks/useClickOutside';

export interface EntitySwitcherItem {
  id: string;
  /** The name the row leads with. */
  primary: string;
  /** A qualifier shown beside it -- a security's name, a payee's category. */
  secondary?: ReactNode;
  /**
   * Text the filter matches against. Defaults to `primary`; pass the fields
   * a reader would actually type (a security matches on symbol or name).
   */
  searchText?: string;
  /**
   * Heading this row sits under, for a list long enough that sections are how
   * a reader finds anything (the reports switcher groups by section). Sections
   * appear in the order their first item does, so the caller decides the order
   * by ordering `items`. Omit on every item for a flat list.
   */
  group?: string;
}

interface EntitySwitcherProps {
  /** The entity currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Entities to switch between. Empty until the list has loaded. */
  items: readonly EntitySwitcherItem[];
  onSelect: (id: string) => void;
  /** Accessible name and tooltip for the caret, e.g. "Switch payee". */
  triggerLabel: string;
  /**
   * Words on the trigger beside the chevron, for a page carrying two switchers
   * -- the GEM report's scenario picker sits a few pixels from the caret that
   * switches reports, and two bare chevrons say nothing about which is which.
   * Omit for the usual single caret beside a title.
   */
  triggerText?: string;
  filterPlaceholder: string;
  noMatchesLabel: string;
  /**
   * Where the secondary text sits. `inline` follows the primary immediately and
   * truncates (a symbol then its long name); `end` pushes it to the right edge
   * and truncates the primary instead (a payee name then its category).
   */
  secondaryAlign?: 'inline' | 'end';
}

/** Beyond this many, scanning the list is slower than typing into the filter. */
const FILTER_THRESHOLD = 8;

/**
 * A caret beside a detail page's title that jumps straight to another entity of
 * the same kind, without going back to the list and clicking through again. The
 * securities, payees and accounts detail headers all use it, so the behaviour is
 * defined once rather than reimplemented per page.
 *
 * Items may carry a `group`, in which case the menu is split into labelled
 * sections -- how the reports switcher makes fifty entries scannable.
 *
 * The filter appears only once the list is long enough to need it: for a handful
 * of entities the box is one more thing to skip past, and for a hundred it is
 * the only way through. Closes on click-outside and on Escape, which returns
 * focus to the caret -- the same behaviour as the app's other header menus.
 */
export function EntitySwitcher({
  currentId,
  items,
  onSelect,
  triggerLabel,
  triggerText,
  filterPlaceholder,
  noMatchesLabel,
  secondaryAlign = 'end',
}: EntitySwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setIsOpen(false);
    setQuery('');
  };

  useClickOutside(containerRef, close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  const others = useMemo(
    () => items.filter((item) => item.id !== currentId),
    [items, currentId],
  );

  const showFilter = others.length > FILTER_THRESHOLD;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return others;
    return others.filter((item) =>
      (item.searchText ?? item.primary).toLowerCase().includes(needle),
    );
  }, [others, query]);

  /**
   * The matches split into sections, in first-appearance order. Built from the
   * filtered set rather than the whole list, so a section whose every row was
   * filtered out takes its heading with it.
   */
  const sections = useMemo(() => {
    const names = matches.reduce<string[]>((acc, item) => {
      const name = item.group ?? '';
      return acc.includes(name) ? acc : [...acc, name];
    }, []);
    return names.map((name) => ({
      name,
      items: matches.filter((item) => (item.group ?? '') === name),
    }));
  }, [matches]);

  // Nothing to switch to: the caret would open an empty list.
  if (others.length === 0) return null;

  const renderItem = (item: EntitySwitcherItem) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      onClick={() => {
        close();
        onSelect(item.id);
      }}
      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors motion-reduce:transition-none hover:bg-gray-50 dark:hover:bg-gray-700"
    >
      <span
        className={`text-sm font-medium text-gray-900 dark:text-gray-100 ${
          secondaryAlign === 'inline' ? 'shrink-0' : 'min-w-0 truncate'
        }`}
      >
        {item.primary}
      </span>
      {item.secondary != null && item.secondary !== '' && (
        <span
          className={`text-xs text-gray-500 dark:text-gray-400 ${
            secondaryAlign === 'inline' ? 'truncate' : 'ml-auto shrink-0'
          }`}
        >
          {item.secondary}
        </span>
      )}
    </button>
  );

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        // Closing goes through `close()` so the filter is cleared with it.
        // Toggling `isOpen` alone left the query behind, and reopening then
        // showed the previous search instead of the list -- which reads as most
        // of the entries having disappeared.
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerLabel}
        title={triggerLabel}
        className={`inline-flex items-center rounded text-gray-400 transition-colors motion-reduce:transition-none hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700 dark:hover:text-gray-200 ${
          triggerText ? 'gap-0.5 px-1.5 py-1 text-sm' : 'p-1'
        }`}
      >
        {triggerText}
        <ChevronDownIcon
          className={`h-5 w-5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={triggerLabel}
          className="absolute left-0 z-50 mt-1 w-72 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {showFilter && (
            <div className="border-b border-gray-200 p-2 dark:border-gray-700">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                autoFocus
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
          <div className="max-h-72 overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {noMatchesLabel}
              </p>
            ) : (
              sections.map((section) =>
                section.name === '' ? (
                  <Fragment key="ungrouped">
                    {section.items.map(renderItem)}
                  </Fragment>
                ) : (
                  // `role="group"` carries the section's name for assistive
                  // technology, so the visible heading is decoration and is
                  // hidden from it rather than announced twice.
                  <div key={section.name} role="group" aria-label={section.name}>
                    <p
                      aria-hidden="true"
                      className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500"
                    >
                      {section.name}
                    </p>
                    {section.items.map(renderItem)}
                  </div>
                ),
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
