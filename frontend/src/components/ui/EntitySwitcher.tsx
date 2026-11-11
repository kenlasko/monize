'use client';

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { useClickOutside } from '@/hooks/useClickOutside';
import { isTouchDevice } from '@/lib/touch-device';

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
  /**
   * The entity currently on screen. It is not offered as a destination unless
   * `showCurrent` is set.
   */
  currentId: string;
  /**
   * List the current entity too, highlighted, and open the menu scrolled to it
   * -- for a long sectioned list where where-you-are is how you find what is
   * next to it (the reports switcher: on Investment Performance, the other
   * Investment reports are the ones beside it). Picking it just closes the menu.
   */
  showCurrent?: boolean;
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

/** The menu's preferred width (Tailwind `w-72`), narrowed only on a viewport that cannot hold it. */
export const MENU_WIDTH = 288;
/** Breathing room kept between the menu and every viewport edge. */
export const VIEWPORT_MARGIN = 8;
/** Space between the caret and the menu below (or above) it. */
const MENU_GAP = 4;
/** The menu never grows past this; the list inside it scrolls instead. */
const MENU_MAX_HEIGHT = 336;
/** Below this much room under the caret, the menu opens upward if that side has more. */
const FLIP_THRESHOLD = 200;

interface MenuPlacement {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when the menu hangs below the caret. */
  top?: number;
  /** Set when the menu stands above the caret, measured from the viewport bottom. */
  bottom?: number;
}

/**
 * Where the menu goes for a caret at `rect`, in a viewport `viewportWidth` by
 * `viewportHeight`. Pure so the placement can be tested without a layout
 * engine: the menu starts at the caret's left edge and slides left as far as
 * it must to stay `VIEWPORT_MARGIN` inside the right edge; on a viewport
 * narrower than the menu it shrinks to fit instead. It hangs below the caret
 * unless that side is cramped and the space above is larger.
 */
export function placeMenu(
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
  viewportWidth: number,
  viewportHeight: number,
): MenuPlacement {
  const width = Math.max(0, Math.min(MENU_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN));
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    viewportWidth - width - VIEWPORT_MARGIN,
  );
  const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const openUp = spaceBelow < FLIP_THRESHOLD && spaceAbove > spaceBelow;
  const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(0, openUp ? spaceAbove : spaceBelow));
  return openUp
    ? { left, width, maxHeight, bottom: viewportHeight - rect.top + MENU_GAP }
    : { left, width, maxHeight, top: rect.bottom + MENU_GAP };
}

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
 *
 * The menu is rendered through a portal at a fixed position measured from the
 * caret and clamped to the viewport (`placeMenu`), the way `MultiSelect` and
 * the portal `InfoTooltip` place theirs. An `absolute` box under the caret was
 * cut off in the Transactions page's Account Info widget: on a phone the caret
 * follows a long account name and the menu ran off the right edge, and on a
 * desktop the widget column is `overflow-hidden` and translated, which both
 * clips an absolute child and makes the column the containing block of a
 * fixed one. Page scroll and resize re-measure the caret so the menu follows
 * it: closing on them instead made the menu vanish as it opened, because
 * focusing the filter scrolled it into view and a phone's keyboard resized the
 * viewport. The filter is focused with `preventScroll` for the same reason --
 * and only where a pointer is a mouse: focusing a text box on a touch device
 * raises the keyboard over the list the reader opened the menu to see, so
 * there the filter waits to be tapped. The pointer decides, never the
 * viewport (`isTouchDevice`).
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
  showCurrent = false,
}: EntitySwitcherProps) {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentRowRef = useRef<HTMLButtonElement>(null);
  const isOpen = placement !== null;

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlacement(placeMenu(rect, window.innerWidth, window.innerHeight));
  };

  const close = () => {
    setPlacement(null);
    setQuery('');
  };

  // The menu lives in a portal, so it is its own "inside" beside the caret.
  useClickOutside([containerRef, menuRef], close, {
    enabled: isOpen,
    onEscape: () => {
      close();
      triggerRef.current?.focus();
    },
  });

  // A fixed menu measured once would drift from a caret that scrolls or
  // reflows away from it, so every scroll and resize re-measures (one
  // measurement per frame). It must never CLOSE on them: opening itself
  // scrolls and resizes -- the filter taking focus scrolls its container, and
  // a phone's keyboard shrinks the viewport -- so a menu that closed on either
  // flashed open and shut. Scrolling the menu's own list moves no caret.
  useEffect(() => {
    if (!isOpen) return;
    let raf = 0;
    const reposition = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (rect) setPlacement(placeMenu(rect, window.innerWidth, window.innerHeight));
      });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen]);

  // Focus the filter once the menu is up, without scrolling it into view: the
  // scroll that `autoFocus` triggered is what closed the menu on open. Not on
  // a touch device, where focus raises the keyboard over the list.
  useEffect(() => {
    if (isOpen && !isTouchDevice()) filterRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  // Open on the current row, centred in the list, so its neighbours are what
  // the reader sees first. Set directly on the list's own scroll position
  // rather than with `scrollIntoView`, which would also scroll the page -- and
  // a page scroll re-measures the caret. Only on opening: typing in the filter
  // should not keep yanking the list back.
  useLayoutEffect(() => {
    if (!isOpen || !showCurrent) return;
    const list = listRef.current;
    const row = currentRowRef.current;
    if (!list || !row) return;
    list.scrollTop = Math.max(
      0,
      row.offsetTop - list.offsetTop - (list.clientHeight - row.offsetHeight) / 2,
    );
  }, [isOpen, showCurrent]);

  const others = useMemo(
    () => items.filter((item) => item.id !== currentId),
    [items, currentId],
  );

  /** What the menu lists: the others, plus the current one when it is shown. */
  const listed = showCurrent ? items : others;

  const showFilter = listed.length > FILTER_THRESHOLD;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listed;
    return listed.filter((item) =>
      (item.searchText ?? item.primary).toLowerCase().includes(needle),
    );
  }, [listed, query]);

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

  const renderItem = (item: EntitySwitcherItem) => {
    const isCurrent = item.id === currentId;
    return (
      <button
        key={item.id}
        ref={isCurrent ? currentRowRef : undefined}
        type="button"
        role="menuitem"
        aria-current={isCurrent ? 'true' : undefined}
        onClick={() => {
          close();
          // Already here: picking it again only dismisses the menu.
          if (!isCurrent) onSelect(item.id);
        }}
        className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors motion-reduce:transition-none ${
          isCurrent
            ? 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50'
            : 'hover:bg-gray-50 dark:hover:bg-gray-700'
        }`}
      >
        <span
          className={`text-sm ${
            isCurrent
              ? 'font-semibold text-blue-700 dark:text-blue-300'
              : 'font-medium text-gray-900 dark:text-gray-100'
          } ${
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
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        // Closing goes through `close()` so the filter is cleared with it.
        // Toggling `isOpen` alone left the query behind, and reopening then
        // showed the previous search instead of the list -- which reads as most
        // of the entries having disappeared.
        onClick={() => (isOpen ? close() : open())}
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

      {placement &&
        createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={triggerLabel}
          style={{
            position: 'fixed',
            left: placement.left,
            width: placement.width,
            maxHeight: placement.maxHeight,
            top: placement.top,
            bottom: placement.bottom,
          }}
          className="z-[100] flex flex-col overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          {showFilter && (
            <div className="shrink-0 border-b border-gray-200 p-2 dark:border-gray-700">
              <input
                ref={filterRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={filterPlaceholder}
                aria-label={filterPlaceholder}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
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
        </div>,
        document.body,
      )}
    </div>
  );
}
