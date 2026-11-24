'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronUpDownIcon } from '@heroicons/react/20/solid';
import { useClickOutside } from '@/hooks/useClickOutside';
import { isTouchDevice } from '@/lib/touch-device';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { SEPARATOR_VALUE } from '@/lib/account-utils';

export interface IconSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** A mark drawn before the label, in the list and in the closed field. */
  icon?: ReactNode;
}

export interface IconSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'multiple' | 'size'> {
  label?: string;
  error?: string;
  options: IconSelectOption[];
}

export { SEPARATOR_VALUE };
/** Beyond this many rows, scanning the list is slower than typing into the filter. */
export const FILTER_THRESHOLD = 8;
/** Breathing room kept between the list and every viewport edge. */
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
/** The list never grows past this; it scrolls instead. */
const MENU_MAX_HEIGHT = 320;
/** Below this much room under the field, the list opens upward if that side has more. */
const FLIP_THRESHOLD = 200;
/** A narrow field still gets a list wide enough to read an account name in. */
const MENU_MIN_WIDTH = 240;

export interface ListPlacement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * Where the list goes for a field at `rect` in a viewport `viewportWidth` by
 * `viewportHeight`: under the field at its width (never narrower than
 * `MENU_MIN_WIDTH`), slid left to stay inside the right edge, and flipped above
 * the field when the room below is cramped and the room above is larger.
 */
export function samePlacement(a: ListPlacement, b: ListPlacement): boolean {
  return (
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}

export function placeList(
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewportWidth: number,
  viewportHeight: number,
): ListPlacement {
  const width = Math.max(
    0,
    Math.min(Math.max(rect.width, MENU_MIN_WIDTH), viewportWidth - 2 * VIEWPORT_MARGIN),
  );
  const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), viewportWidth - width - VIEWPORT_MARGIN);
  const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const openUp = spaceBelow < FLIP_THRESHOLD && spaceAbove > spaceBelow;
  const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(0, openUp ? spaceAbove : spaceBelow));
  return openUp
    ? { left, width, maxHeight, bottom: viewportHeight - rect.top + MENU_GAP }
    : { left, width, maxHeight, top: rect.bottom + MENU_GAP };
}

const selectValueSetter =
  typeof window === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

/**
 * A single-choice dropdown whose rows carry an icon -- what a native `<select>`
 * cannot draw. It takes `Select`'s props, so a call site swaps one for the
 * other without changing how it reads the value.
 *
 * The form value still lives in a real `<select>`, hidden from sight and from
 * assistive technology: `register()` attaches to it, and a pick sets its value
 * and fires a genuine `change` event, so a react-hook-form field and an
 * `onChange={(e) => set(e.target.value)}` handler both see exactly what a
 * native select would have sent. The visible control is a `combobox` button
 * named by the label, with a portalled `listbox` that follows it the way
 * `EntitySwitcher`'s menu follows its caret (re-measured on scroll and resize,
 * never closed by them). A long list gets a filter box; Escape closes the list
 * without reaching a surrounding dialog.
 *
 * The field reads its value from `value` when it is controlled. An uncontrolled
 * field (only `register()`) tracks its own picks, so a call site that sets the
 * value programmatically passes `value` as well.
 */
export const IconSelect = forwardRef<HTMLSelectElement, IconSelectProps>(function IconSelect(
  {
    label,
    error,
    options,
    className,
    id,
    value,
    defaultValue,
    disabled,
    onChange,
    onBlur,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    title,
    ...selectProps
  },
  ref,
) {
  const t = useTranslations('common');
  const generatedId = useId();
  const triggerId = id || `select-${label?.toLowerCase().replace(/\s+/g, '-') ?? generatedId}`;
  const listId = `${generatedId}-list`;
  const errorId = `${generatedId}-error`;
  const describedBy = [ariaDescribedBy, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  const selectRef = useRef<HTMLSelectElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The caller's ref (a `register()` ref included) lands on the native select,
  // exactly as it would on a `Select`.
  const setSelect = useCallback(
    (element: HTMLSelectElement | null) => {
      selectRef.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  const firstEnabled = options.find((o) => !o.disabled && o.value !== SEPARATOR_VALUE)?.value ?? '';
  const [ownValue, setOwnValue] = useState<string>(() =>
    defaultValue != null ? String(defaultValue) : firstEnabled,
  );
  const current = value != null ? String(value) : ownValue;
  const selected = options.find((o) => o.value === current && o.value !== SEPARATOR_VALUE);

  const [placement, setPlacement] = useState<ListPlacement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const isOpen = placement !== null;

  const choosable = useMemo(
    () => options.filter((o) => o.value !== SEPARATOR_VALUE),
    [options],
  );
  const showFilter = choosable.length > FILTER_THRESHOLD;
  const needle = query.trim().toLowerCase();
  /** What the list draws: every row, separators included, until the reader filters. */
  const shown = useMemo(
    () => (needle ? choosable.filter((o) => o.label.toLowerCase().includes(needle)) : options),
    [needle, choosable, options],
  );

  // A scroll frame that leaves the field where it was keeps the same
  // placement object, so the open list does not re-render every frame.
  // The placement last set, read by `measure` without a state update. Every
  // write to `placement` goes through `measure` or `close`, which keep it.
  const placementRef = useRef<ListPlacement | null>(null);
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = placeList(rect, window.innerWidth, window.innerHeight);
    const prev = placementRef.current;
    if (prev && samePlacement(prev, next)) return;
    placementRef.current = next;
    setPlacement(next);
  }, []);

  const indexOfValue = useCallback(
    (list: IconSelectOption[], target: string) =>
      list.findIndex((o) => o.value === target && !o.disabled && o.value !== SEPARATOR_VALUE),
    [],
  );

  const open = (seed = '') => {
    if (disabled) return;
    setQuery(seed);
    const list = seed
      ? choosable.filter((o) => o.label.toLowerCase().includes(seed.toLowerCase()))
      : options;
    const at = seed ? list.findIndex((o) => !o.disabled) : indexOfValue(list, current);
    setActiveIndex(at >= 0 ? at : list.findIndex((o) => !o.disabled && o.value !== SEPARATOR_VALUE));
    measure();
  };

  const close = (refocus = false) => {
    placementRef.current = null;
    setPlacement(null);
    setQuery('');
    setActiveIndex(-1);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (option: IconSelectOption) => {
    if (option.disabled || option.value === SEPARATOR_VALUE) return;
    close(true);
    if (option.value === current) return;
    if (value == null) setOwnValue(option.value);
    const select = selectRef.current;
    if (!select) return;
    // The value goes through the native setter and a real change event, so
    // React reports it to `onChange` exactly as it reports a native pick.
    selectValueSetter?.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  useClickOutside([containerRef, menuRef], () => close(), { enabled: isOpen });

  // Follow the field while the page scrolls or resizes; scrolling the list
  // itself moves nothing.
  useEffect(() => {
    if (!isOpen) return;
    let raf = 0;
    const reposition = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, measure]);

  // The filter takes the keyboard once the list is up -- not on a touch
  // device, where focus would raise the keyboard over the list.
  useEffect(() => {
    if (isOpen && showFilter && !isTouchDevice()) filterRef.current?.focus({ preventScroll: true });
  }, [isOpen, showFilter]);

  useLayoutEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, activeIndex]);

  const step = (from: number, delta: 1 | -1) => {
    for (let at = from + delta; at >= 0 && at < shown.length; at += delta) {
      const option = shown[at];
      if (!option.disabled && option.value !== SEPARATOR_VALUE) return at;
    }
    return from;
  };

  const handleListKeys = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((at) => step(at, 1));
        return true;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((at) => step(at, -1));
        return true;
      case 'Home':
        event.preventDefault();
        setActiveIndex(step(-1, 1));
        return true;
      case 'End':
        event.preventDefault();
        setActiveIndex(step(shown.length, -1));
        return true;
      case 'Enter':
        event.preventDefault();
        if (shown[activeIndex]) choose(shown[activeIndex]);
        return true;
      case 'Escape':
        // Only the list closes; a surrounding dialog stays open.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return true;
      case 'Tab':
        // Back to the field first, so Tab moves on from it rather than from
        // the filter box, which is about to disappear.
        close(true);
        return true;
      default:
        return false;
    }
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        open();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Typing on the closed field starts a search, as on a native select.
        event.preventDefault();
        if (showFilter) open(event.key);
        else {
          const at = choosable.findIndex(
            (o) => !o.disabled && o.label.toLowerCase().startsWith(event.key.toLowerCase()),
          );
          if (at >= 0) choose(choosable[at]);
        }
      }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (shown[activeIndex]) choose(shown[activeIndex]);
      return;
    }
    handleListKeys(event);
  };

  // The field is left when focus goes somewhere that is neither the field nor
  // its list -- from the button or from the filter box, open or closed -- and
  // the caller hears it as the native select's blur (react-hook-form marks the
  // field touched). Moving between the button and the filter is not leaving.
  const handleFocusLeave = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (containerRef.current?.contains(next) || menuRef.current?.contains(next))
    ) {
      return;
    }
    const select = selectRef.current;
    if (select) {
      onBlur?.({ ...event, target: select, currentTarget: select } as FocusEvent<HTMLSelectElement>);
    }
  };

  const isPlaceholder = current === '';
  const activeId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={triggerId}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          {label}
        </label>
      )}
      <div ref={containerRef} className="relative">
        {/* The form's value. Hidden from sight and from assistive technology:
            the button below is the control a person uses. */}
        <select
          ref={setSelect}
          value={value}
          defaultValue={value == null ? defaultValue : undefined}
          disabled={disabled}
          onChange={(event) => {
            if (value == null) setOwnValue(event.target.value);
            onChange?.(event);
          }}
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
          data-icon-select-native=""
          {...selectProps}
          // A form that focuses its first invalid field (react-hook-form's
          // `shouldFocusError`) reaches this select; the person gets the field.
          onFocus={() => triggerRef.current?.focus()}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listId : undefined}
          aria-activedescendant={isOpen && !showFilter ? activeId : undefined}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          title={title}
          disabled={disabled}
          onClick={() => (isOpen ? close() : open())}
          onKeyDown={handleTriggerKeyDown}
          onBlur={handleFocusLeave}
          className={cn(
            inputBaseClasses,
            'flex items-center gap-2 border bg-white py-2 pl-3 pr-8 text-left font-sans focus:outline-none focus-visible:ring-1 dark:bg-gray-800',
            isPlaceholder ? 'text-gray-400' : 'text-gray-900 dark:text-gray-100',
            error && inputErrorClasses,
            className,
          )}
        >
          {selected?.icon != null && (
            <span aria-hidden="true" className="flex shrink-0">
              {selected.icon}
            </span>
          )}
          {/* A non-breaking space holds a line of text while nothing is
              picked -- options still loading, or a value not among them -- so
              the field keeps its height instead of collapsing to its padding. */}
          <span className="min-w-0 flex-1 truncate">{selected?.label || ' '}</span>
          <ChevronUpDownIcon
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
          />
        </button>
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {placement &&
        createPortal(
          <div
            ref={menuRef}
            // A press inside the list (its scrollbar, a rule, a heading) keeps
            // focus where it is; only the filter box takes it.
            onMouseDown={(event) => {
              if (event.target !== filterRef.current) event.preventDefault();
            }}
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
                  onBlur={handleFocusLeave}
                  type="text"
                  value={query}
                  onChange={(event) => {
                    const next = event.target.value;
                    setQuery(next);
                    const lower = next.trim().toLowerCase();
                    const list = lower
                      ? choosable.filter((o) => o.label.toLowerCase().includes(lower))
                      : options;
                    setActiveIndex(
                      list.findIndex((o) => !o.disabled && o.value !== SEPARATOR_VALUE),
                    );
                  }}
                  onKeyDown={(event) => {
                    handleListKeys(event);
                  }}
                  role="searchbox"
                  aria-label={t('iconSelect.filter')}
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  placeholder={t('iconSelect.filter')}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            )}
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={label ? undefined : triggerId}
              aria-label={label ?? ariaLabel}
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {shown.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {t('iconSelect.noMatches')}
                </p>
              ) : (
                shown.map((option, index) =>
                  option.value === SEPARATOR_VALUE ? (
                    <div
                      key={`${option.value}-${index}`}
                      role="separator"
                      className="my-1 border-t border-gray-200 dark:border-gray-700"
                    />
                  ) : (
                    <div
                      key={option.value}
                      id={`${listId}-${index}`}
                      data-index={index}
                      data-value={option.value}
                      role="option"
                      aria-selected={option.value === current}
                      aria-disabled={option.disabled || undefined}
                      // Keep focus on the field (or the filter) through the click.
                      onMouseDown={(event) => event.preventDefault()}
                      // The pointer's highlight is CSS; the active row (the
                      // one Enter picks and the reader hears) moves with the
                      // keyboard only, so hovering redraws nothing.
                      onClick={() => choose(option)}
                      className={cn(
                        'flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm',
                        option.disabled
                          ? 'cursor-default text-gray-400 dark:text-gray-500'
                          : 'text-gray-900 dark:text-gray-100',
                        !option.disabled && index !== activeIndex && 'hover:bg-blue-50 dark:hover:bg-blue-900/50',
                        index === activeIndex && 'bg-blue-100 dark:bg-blue-900',
                        option.value === current && index !== activeIndex && 'bg-blue-50 dark:bg-blue-900/30',
                        option.value === current && 'font-semibold',
                      )}
                    >
                      {option.icon != null && (
                        <span aria-hidden="true" className="flex shrink-0">
                          {option.icon}
                        </span>
                      )}
                      <span className="min-w-0 truncate">{option.label}</span>
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
});
