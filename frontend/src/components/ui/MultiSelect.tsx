'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';

export interface MultiSelectOption {
  value: string;
  label: string;
  parentId?: string | null;  // For hierarchical options
  children?: MultiSelectOption[];  // Child options
  /**
   * Close a group after this option: the row that follows it is drawn with a
   * rule above it. Suppressed while searching, because the list is flattened
   * to matches and the boundary the rule marks no longer holds, and it draws
   * nothing when this option is the last one left.
   */
  separatorAfter?: boolean;
}

interface MultiSelectProps {
  label?: string;
  ariaLabel?: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  showSearch?: boolean;
  error?: string;
  disabled?: boolean;
  onCreateNew?: () => void;
  createNewLabel?: string;
  /**
   * Size the trigger to the longest option label at first render and keep it
   * there. Without this the button is as wide as whatever is currently
   * selected, so picking a security with a long name visibly stretches the
   * control and picking a short one shrinks it back -- the toolbar around it
   * reflows on every selection. The width comes from invisible zero-height
   * copies of the widest labels rendered inside the button, so it needs no
   * measurement pass and tracks the real font.
   */
  sizeToLongestOption?: boolean;
  /**
   * `caret` draws the trigger as a bare chevron, for a control that sits
   * beside text already naming the selection (the Investments pinned bar's
   * "Investments - <accounts>"). `ariaLabel` names it. The menu is at least
   * 16rem wide, since the caret is far narrower than its options, and is
   * kept inside the viewport.
   */
  variant?: 'field' | 'caret';
}

/** The caret variant's menu: wide enough for an account name and its checkbox. */
const CARET_MENU_MIN_WIDTH = 256;

export function MultiSelect({
  label,
  ariaLabel,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  showSearch = true,
  error,
  disabled = false,
  onCreateNew,
  createNewLabel = 'Create new...',
  sizeToLongestOption = false,
  variant = 'field',
}: MultiSelectProps) {
  const isCaret = variant === 'caret';
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [dropdownPos, setDropdownPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Build a flat list with hierarchy info for display, and a map for lookups
  const { flatOptions, optionMap } = useMemo(() => {
    const result: Array<MultiSelectOption & { level: number; hasChildren: boolean; parentValue?: string }> = [];
    const map = new Map<string, MultiSelectOption>();

    const addOptions = (opts: MultiSelectOption[], level: number, parentValue?: string) => {
      opts.forEach(opt => {
        const hasChildren = opt.children && opt.children.length > 0;
        result.push({ ...opt, level, hasChildren: hasChildren || false, parentValue });
        map.set(opt.value, opt);
        if (opt.children && opt.children.length > 0) {
          addOptions(opt.children, level + 1, opt.value);
        }
      });
    };

    // Separate parent (top-level) and child options
    const topLevel = options.filter(o => !o.parentId);
    addOptions(topLevel, 0);

    return { flatOptions: result, optionMap: map };
  }, [options]);

  // Get all descendant IDs for a parent option by traversing children arrays
  const getDescendantIds = (parentValue: string): string[] => {
    const descendants: string[] = [];
    const findInOption = (opt: MultiSelectOption) => {
      if (opt.children) {
        opt.children.forEach(child => {
          descendants.push(child.value);
          findInOption(child);
        });
      }
    };
    const parent = optionMap.get(parentValue);
    if (parent) {
      findInOption(parent);
    }
    return descendants;
  };

  // Check selection state for a parent option
  const getSelectionState = (optionValue: string, hasChildren: boolean): 'none' | 'some' | 'all' => {
    if (!hasChildren) {
      return value.includes(optionValue) ? 'all' : 'none';
    }

    const descendantIds = getDescendantIds(optionValue);
    if (descendantIds.length === 0) {
      return value.includes(optionValue) ? 'all' : 'none';
    }

    const selectedCount = descendantIds.filter(id => value.includes(id)).length;
    const parentSelected = value.includes(optionValue);

    if (selectedCount === 0 && !parentSelected) return 'none';
    if (selectedCount === descendantIds.length && parentSelected) return 'all';
    return 'some';
  };

  // Handle option toggle
  const handleToggle = (optionValue: string, hasChildren: boolean) => {
    const currentlySelected = value.includes(optionValue);
    let newValue: string[];

    if (hasChildren) {
      // Parent option - toggle all descendants
      const descendantIds = getDescendantIds(optionValue);
      const allIds = [optionValue, ...descendantIds];

      if (currentlySelected) {
        // Uncheck parent and all descendants
        newValue = value.filter(v => !allIds.includes(v));
      } else {
        // Check parent and all descendants
        newValue = [...new Set([...value, ...allIds])];
      }
    } else {
      // Child option - toggle just this one
      if (currentlySelected) {
        newValue = value.filter(v => v !== optionValue);
      } else {
        newValue = [...value, optionValue];
      }

      // Update parent state based on children
      const flatOption = flatOptions.find(o => o.value === optionValue);
      if (flatOption?.parentValue) {
        const parentOpt = optionMap.get(flatOption.parentValue);
        if (parentOpt?.children) {
          const allSiblingsSelected = parentOpt.children.every(sibling =>
            sibling.value === optionValue ? !currentlySelected : newValue.includes(sibling.value)
          );

          if (allSiblingsSelected && !newValue.includes(flatOption.parentValue)) {
            newValue.push(flatOption.parentValue);
          } else if (!allSiblingsSelected && newValue.includes(flatOption.parentValue)) {
            newValue = newValue.filter(v => v !== flatOption.parentValue);
          }
        }
      }
    }

    onChange(newValue);
  };

  // Filter options by search
  const filteredOptions = useMemo(() => {
    if (!searchText) return flatOptions;
    const searchLower = searchText.toLowerCase();
    return flatOptions.filter(opt =>
      opt.label.toLowerCase().includes(searchLower)
    );
  }, [flatOptions, searchText]);

  // Select all / clear all - only affects visible (filtered) options
  const handleSelectAll = () => {
    const visibleValues = filteredOptions.map(o => o.value);
    // Add all visible options to current selection
    const newValue = [...new Set([...value, ...visibleValues])];
    onChange(newValue);
  };

  const handleClearAll = () => {
    const visibleValues = new Set(filteredOptions.map(o => o.value));
    // Remove only visible options from current selection
    const newValue = value.filter(v => !visibleValues.has(v));
    onChange(newValue);
  };

  // Calculate dropdown position from trigger button. Opens downward by
  // default, but flips above the trigger when there isn't enough room below
  // (e.g. the field sits near the bottom of the viewport / a modal). Either
  // way the height is capped to the available space so the options list
  // scrolls internally rather than spilling off-screen.
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    // Prefer below; flip up only when below is cramped and above has more room.
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow);
    const width = isCaret ? Math.max(rect.width, CARET_MENU_MIN_WIDTH) : rect.width;
    const left = isCaret
      ? Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))
      : rect.left;
    setDropdownPos({
      left,
      width,
      maxHeight,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    });
  }, [isCaret]);

  // Update position when opening
  useEffect(() => {
    if (isOpen) updatePosition();
  }, [isOpen, updatePosition]);

  // Close on parent scroll or window resize (dropdown would be misaligned)
  useEffect(() => {
    if (!isOpen) return;
    const handleScrollOrResize = (event: Event) => {
      if (dropdownRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
      setSearchText('');
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [isOpen]);

  // Close on click outside
  useClickOutside([wrapperRef, dropdownRef], () => {
    setIsOpen(false);
    setSearchText('');
  });

  // Focus search input when opening
  useEffect(() => {
    if (isOpen && showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen, showSearch]);

  /**
   * The candidate widest labels, for the trigger's sizer. Character count is a
   * proxy -- the font is proportional -- so several of the longest are rendered
   * and the browser takes the true maximum, rather than betting on one.
   */
  const sizerLabels = useMemo(() => {
    if (!sizeToLongestOption) return [];
    return [...flatOptions.map(o => o.label), placeholder]
      .sort((a, b) => b.length - a.length)
      .slice(0, 5);
  }, [sizeToLongestOption, flatOptions, placeholder]);

  // Display text
  const displayText = useMemo(() => {
    if (value.length === 0) return placeholder;
    if (value.length === 1) {
      const opt = flatOptions.find(o => o.value === value[0]);
      return opt?.label || t('multiSelect.selectedCount', { count: 1 });
    }
    return t('multiSelect.selectedCount', { count: value.length });
  }, [value, flatOptions, placeholder, t]);

  return (
    <div ref={wrapperRef} className={isCaret ? 'relative inline-block' : 'w-full relative'}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}

      {/* Trigger button */}
      {isCaret ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => !disabled && setIsOpen(!isOpen)}
          disabled={disabled}
          aria-label={ariaLabel}
          title={ariaLabel}
          aria-expanded={isOpen}
          className={cn(
            'inline-flex items-center rounded p-1 text-gray-400 transition-colors motion-reduce:transition-none',
            'hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            'dark:hover:bg-gray-700 dark:hover:text-gray-200',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <ChevronDownIcon
            className={cn('h-5 w-5 transition-transform', isOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      ) : (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          'block w-full rounded-md border border-gray-300 shadow-sm px-3 py-2 text-left',
          'focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none',
          'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
          'dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100',
          'dark:focus:border-blue-400 dark:focus:ring-blue-400',
          'dark:disabled:bg-gray-700 dark:disabled:text-gray-400',
          error && 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-500'
        )}
      >
        <div className="flex items-center justify-between">
          <span className={cn(
            'truncate',
            value.length === 0 && 'text-gray-400 dark:text-gray-400'
          )}>
            {displayText}
          </span>
          <ChevronDownIcon
            className={cn('h-5 w-5 text-gray-400 transition-transform', isOpen && 'rotate-180')}
            aria-hidden="true"
          />
        </div>
        {sizerLabels.length > 0 && (
          /* Invisible, zero-height copies of the widest labels: they give the
             button its intrinsic width so the visible row cannot. The text
             reaches the page through CSS content, not as DOM text -- the
             browser still measures it in the real font, but it cannot be
             found by text queries, duplicate what screen readers announce, or
             be caught by the user's find-in-page. pr-7 stands in for the
             chevron and its gap.

             Each copy is capped at `100vw - 12rem`, which is the sizer's whole
             safety net: the copies never wrap, so an unbounded one makes the
             trigger's *minimum* width the longest label and no ancestor can
             shrink it -- a security named beyond the width of a phone pushed
             the control, and the toolbar around it, off the right of the
             screen. The cap is a definite length, so it clamps that intrinsic
             contribution; 12rem clears the widest page and card padding this
             app puts around a toolbar (lg:px-12 plus p-4), so the trigger
             stays inside the viewport at every breakpoint. Below the cap
             nothing changes -- the control is still as wide as its longest
             option -- and above it the trigger shrinks and the selected label
             truncates, which is what the visible row is already built for. */
          <div aria-hidden="true" data-testid="multiselect-sizer" className="h-0 overflow-hidden">
            {sizerLabels.map(sizerLabel => (
              <div
                key={sizerLabel}
                data-sizer={sizerLabel}
                className="invisible max-w-[calc(100vw-12rem)] whitespace-nowrap pr-7 after:content-[attr(data-sizer)]"
              />
            ))}
          </div>
        )}
      </button>
      )}

      {/* Dropdown (portal-rendered to avoid overflow clipping) */}
      {isOpen && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[100] flex flex-col overflow-hidden bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 rounded-md ring-1 ring-black ring-opacity-5 dark:ring-gray-600"
          style={{
            top: dropdownPos.top,
            bottom: dropdownPos.bottom,
            left: dropdownPos.left,
            width: dropdownPos.width,
            maxHeight: dropdownPos.maxHeight,
          }}
        >
          {/* Search input */}
          {showSearch && (
            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t('multiSelect.search')}
                  className={cn(
                    'block w-full rounded-md border-gray-300 shadow-sm text-sm pr-8',
                    'focus:border-blue-500 focus:ring-blue-500',
                    'dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400'
                  )}
                />
                {searchText && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchText('');
                      searchInputRef.current?.focus();
                    }}
                    aria-label={t('multiSelect.clearSearch')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    <XMarkIcon className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Select All / Clear */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm">
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {t('multiSelect.selectAll')}
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            >
              {t('multiSelect.clear')}
            </button>
          </div>

          {/* Options list */}
          <div className="flex-1 min-h-0 overflow-auto py-1">
            {filteredOptions.length === 0 && !onCreateNew ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                {t('multiSelect.noOptions')}
              </div>
            ) : (
              <>
                {filteredOptions.length === 0 && (
                  <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {t('multiSelect.noOptions')}
                  </div>
                )}
                {filteredOptions.map((option, index) => {
                  const selectionState = getSelectionState(option.value, option.hasChildren);
                  const isChecked = selectionState === 'all';
                  const isIndeterminate = selectionState === 'some';

                  // When searching, show parent name for context (flatten the hierarchy)
                  const isSearching = searchText.length > 0;
                  const parentLabel = option.parentValue ? optionMap.get(option.parentValue)?.label : null;

                  // The rule belongs to the row below the boundary rather than
                  // to a divider element of its own, so it cannot outlive the
                  // rows it separates when a search empties one side.
                  const startsGroup =
                    !isSearching && filteredOptions[index - 1]?.separatorAfter === true;

                  return (
                    <label
                      key={option.value}
                      className={cn(
                        'flex items-center px-3 py-2 cursor-pointer',
                        'transition-colors motion-reduce:transition-none hover:bg-gray-100 dark:hover:bg-gray-700',
                        option.hasChildren && 'font-medium',
                        startsGroup && 'mt-1 border-t border-gray-200 dark:border-gray-700'
                      )}
                      style={{ paddingLeft: isSearching ? '0.75rem' : `${(option.level * 1.25) + 0.75}rem` }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = isIndeterminate;
                        }}
                        onChange={() => handleToggle(option.value, option.hasChildren)}
                        className={cn(
                          'h-4 w-4 rounded border-gray-300 text-blue-600',
                          'focus:ring-blue-500 focus:ring-offset-0',
                          'dark:border-gray-500 dark:bg-gray-700 dark:focus:ring-blue-400'
                        )}
                      />
                      <span className={cn(
                        'ml-2 text-sm text-gray-900 dark:text-gray-100',
                        option.hasChildren && 'font-medium'
                      )}>
                        {isSearching && parentLabel && (
                          <span className="text-gray-500 dark:text-gray-400">
                            {parentLabel} &rsaquo;{' '}
                          </span>
                        )}
                        {option.label}
                      </span>
                    </label>
                  );
                })}
              </>
            )}
          </div>

          {/* Create new option */}
          {onCreateNew && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => {
                  onCreateNew();
                  setIsOpen(false);
                  setSearchText('');
                }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 text-sm',
                  'text-green-700 dark:text-green-400',
                  'hover:bg-green-50 dark:hover:bg-green-900/30',
                )}
              >
                <PlusIcon className="w-4 h-4" aria-hidden="true" />
                {createNewLabel}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}

      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
