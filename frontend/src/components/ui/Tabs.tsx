'use client';

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

export interface TabItem<K extends string = string> {
  /** Stable identifier, also used to build the aria ids. */
  key: K;
  label: string;
}

interface TabsProps<K extends string> {
  tabs: readonly TabItem<K>[];
  /** The selected tab's key. */
  value: K;
  onChange: (key: K) => void;
  /**
   * Namespace for the generated `id`s, so two tab sets on one page keep their
   * `aria-controls` / `aria-labelledby` pairs distinct.
   */
  idPrefix: string;
  /** Names the tab set for screen readers. */
  ariaLabel: string;
  className?: string;
  /**
   * Attributes (a `data-tour-id`) for the tablist itself, following the same
   * convention as `FormActions`. A guided tour rings the row of tabs, and a
   * wrapper element around this component would ring the negative gutters a
   * caller adds to bleed the row to the screen edge instead.
   */
  anchorProps?: Record<string, string>;
}

/** The id of a tab button, so a panel can point back at it. */
export function tabId(idPrefix: string, key: string): string {
  return `${idPrefix}-tab-${key}`;
}

/** The id of a tab's panel, so the button can point at it. */
export function tabPanelId(idPrefix: string, key: string): string {
  return `${idPrefix}-panel-${key}`;
}

/**
 * The app's tab bar: an underlined row of tabs, styled exactly like the two
 * hand-rolled tablists it generalises (`DelegateAccessModal`,
 * `ScheduledTransactionForm`), so nothing changes visually.
 *
 * What it adds over those two is the keyboard behaviour the ARIA tabs pattern
 * expects and neither had: one tab stop for the whole set (roving tabindex),
 * arrow keys to move between tabs, Home/End to jump to the ends. Selection
 * follows focus, which is the right choice here because switching a panel is
 * cheap and has no side effects.
 *
 * The row scrolls horizontally on its own when the tabs outgrow the viewport,
 * so a narrow screen never widens the page itself. A phone draws no scrollbar,
 * so on its own that scroll is invisible: five tabs on the security detail page
 * fit a 390px screen up to the fourth, and nothing said a fifth existed. Two
 * things make the overflow legible without a bar. The wrapper fades the
 * content out at whichever edge has more behind it (`scroll-fade-x`, driven by
 * a `data-overflow` attribute the scroll and resize handlers keep current), and
 * the selected tab is scrolled into view whenever the selection changes, so a
 * deep link to the last tab opens with that tab on screen.
 */

type OverflowEdge = 'none' | 'start' | 'end' | 'both';

/** Which edge(s) of a horizontal scroller still have content behind them. */
export function overflowEdge(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): OverflowEdge {
  // A 1px tolerance: sub-pixel layouts report a scrollWidth one pixel past
  // clientWidth on a row that does not scroll at all.
  const hidden = el.scrollWidth - el.clientWidth;
  if (hidden <= 1) return 'none';
  const atStart = el.scrollLeft <= 1;
  const atEnd = el.scrollLeft >= hidden - 1;
  if (atStart) return 'end';
  if (atEnd) return 'start';
  return 'both';
}
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  idPrefix,
  ariaLabel,
  className = '',
  anchorProps,
}: TabsProps<K>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // The fade is a DOM attribute written from the scroll and resize handlers,
  // not React state: reading layout and setting state in an effect is banned
  // here, and nothing else needs to know which edge is faded.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      scroller.dataset.overflow = overflowEdge(scroller);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [tabs]);

  // A tab selected from outside the row (a `?tab=` deep link, a widget's link
  // to Price history) can sit past the visible edge; bring it on screen.
  useEffect(() => {
    const index = tabs.findIndex((tab) => tab.key === value);
    const button = buttonRefs.current[index];
    if (button && typeof button.scrollIntoView === 'function') {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [tabs, value]);

  const selectAt = useCallback(
    (index: number) => {
      // Wrap around both ends, as the tabs pattern specifies.
      const wrapped = (index + tabs.length) % tabs.length;
      const next = tabs[wrapped];
      if (!next) return;
      onChange(next.key);
      buttonRefs.current[wrapped]?.focus();
    },
    [onChange, tabs],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          selectAt(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          selectAt(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          selectAt(0);
          break;
        case 'End':
          event.preventDefault();
          selectAt(tabs.length - 1);
          break;
        default:
          break;
      }
    },
    [selectAt, tabs.length],
  );

  return (
    // The scroll lives on a wrapper, not on the tablist, and it carries `pb-px`
    // to absorb the 1px the active tab's `-mb-px` overhangs by. Without that
    // padding, setting overflow-x makes the browser compute overflow-y to `auto`
    // as well, and that 1px of vertical overflow draws a stray vertical
    // scrollbar beside the tabs.
    <div
      ref={scrollerRef}
      data-overflow="none"
      className={`scroll-fade-x overflow-x-auto pb-px ${className}`}
    >
      <div
        role="tablist"
        aria-label={ariaLabel}
        {...anchorProps}
        className="flex gap-1 border-b border-gray-200 dark:border-gray-700"
      >
        {tabs.map((tab, index) => {
          const isSelected = tab.key === value;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                buttonRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabId(idPrefix, tab.key)}
              aria-selected={isSelected}
              // Only the selected tab's panel is in the DOM (see TabPanel), and
              // aria-controls must not point at an element that is not there.
              aria-controls={
                isSelected ? tabPanelId(idPrefix, tab.key) : undefined
              }
              // One tab stop for the set: Tab reaches the selected tab, then
              // moves on into the panel rather than through every other tab.
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 rounded-t-sm ${
                isSelected
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface TabPanelProps {
  /** Must match the `idPrefix` given to the `Tabs` it belongs to. */
  idPrefix: string;
  /** The key of the tab this panel belongs to. */
  tabKey: string;
  /** Rendered only when this panel's tab is the selected one. */
  isActive: boolean;
  /**
   * Keep the panel mounted once it has been opened, hidden while another tab is
   * selected, instead of unmounting it.
   *
   * For a panel that fetches its own data. Unmounting throws that data away, so
   * every return to the tab refetches and shows its loading state again, which
   * reads as the page reloading. Leave it off for a panel that is cheap to
   * rebuild -- an unopened panel is still never mounted either way, so nothing
   * requests data for a tab nobody visited.
   */
  keepMounted?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * The panel half of the pair.
 *
 * A panel is not mounted until its tab is first selected, so the panels on the
 * security detail page do not fire requests for tabs nobody opened. What happens
 * after that is `keepMounted`'s choice.
 */
export function TabPanel({
  idPrefix,
  tabKey,
  isActive,
  keepMounted = false,
  children,
  className = '',
}: TabPanelProps) {
  // "Information from the previous render": tracked in state and updated during
  // render, because `setState` in an effect is an error in this codebase.
  const [hasBeenActive, setHasBeenActive] = useState(isActive);
  if (isActive && !hasBeenActive) setHasBeenActive(true);

  const shouldRender = isActive || (keepMounted && hasBeenActive);
  if (!shouldRender) return null;

  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, tabKey)}
      aria-labelledby={tabId(idPrefix, tabKey)}
      // `hidden` rather than a class, so the panel is out of the accessibility
      // tree and out of the tab order as well as off screen.
      hidden={!isActive}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
