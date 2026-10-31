'use client';

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useClickOutside } from '@/hooks/useClickOutside';
import { createPortal } from 'react-dom';
import { placePopover } from './InfoTooltip';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';

interface ComboboxOption {
  value: string;
  label: string;
  subtitle?: string;
  /** Additional search terms that participate in filtering but are not displayed by default */
  keywords?: string[];
}

interface ComboboxProps {
  label?: string;
  placeholder?: string;
  options: ComboboxOption[];
  value?: string;
  initialDisplayValue?: string;
  onChange: (value: string, label: string) => void;
  onInputChange?: (value: string) => void;
  onCreateNew?: (name: string) => void;
  error?: string;
  disabled?: boolean;
  allowCustomValue?: boolean;
  /** Render dropdown in a portal to escape overflow clipping (e.g. inside modals) */
  usePortal?: boolean;
  /** Always show option subtitles, not just when filtering */
  alwaysShowSubtitle?: boolean;
  /** Values to sort to the top of the list when not filtering */
  priorityValues?: string[];
  /**
   * Open the dropdown when the input gains focus. Defaults to true. Set false
   * when the field may be auto-focused (e.g. it is the first focusable element
   * in a modal) so the list only opens on an explicit click, keypress, or type.
   */
  openOnFocus?: boolean;
  /**
   * The `value` prop is an opaque id (e.g. a UUID), so it must never be
   * rendered as input text -- when it cannot be resolved to an option label
   * yet (options still loading), the field shows `initialDisplayValue` or
   * stays blank instead. Set this on every id-backed combobox that also sets
   * `allowCustomValue` (whose custom values are reported via
   * `onChange('', text)`, never through `value`).
   */
  valueIsId?: boolean;
  /** Accessible name for the input when there is no visible `label`. */
  'aria-label'?: string;
  /**
   * When set, each option row gets a delete control that calls this instead of
   * selecting the option. For lists the user owns (e.g. free-text asset
   * classes) -- the parent performs the deletion and refreshes `options`.
   */
  onDeleteOption?: (value: string, label: string) => void;
  /** Accessible name for the per-option delete control. */
  deleteOptionAriaLabel?: string;
}

export function Combobox({
  label,
  placeholder = 'Select or type...',
  options,
  value,
  initialDisplayValue,
  onChange,
  onInputChange,
  onCreateNew,
  error,
  disabled = false,
  allowCustomValue = false,
  usePortal = false,
  alwaysShowSubtitle = false,
  priorityValues,
  openOnFocus = true,
  valueIsId = false,
  'aria-label': ariaLabel,
  onDeleteOption,
  deleteOptionAriaLabel,
}: ComboboxProps) {
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(initialDisplayValue || '');
  const [selectedLabel, setSelectedLabel] = useState(initialDisplayValue || '');
  const [isTyping, setIsTyping] = useState(false);
  const [filterText, setFilterText] = useState(''); // Separate filter text for searching
  const [hasInitialized, setHasInitialized] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDeleteRef = useRef(false);
  const isNavigatingRef = useRef(false);
  const prevFilterTextRef = useRef('');

  // Calculate portal dropdown position from input element
  const updateDropdownPos = useCallback(() => {
    if (!usePortal || !inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const position = placePopover(rect,
      { width: rect.width, height: listRef.current?.offsetHeight || 240 },
      'bottom', { width: window.innerWidth, height: window.innerHeight });
    setDropdownPos({ ...position, width: rect.width });
  }, [usePortal]);

  // Measure before paint so a low input opens upward without scrolling the page.
  useLayoutEffect(() => {
    if (isOpen && usePortal) updateDropdownPos();
  }, [isOpen, usePortal, updateDropdownPos]);

  // Keep the portal anchored while its modal scrolls, including a delayed scroll
  // event from focusing the input. Closing here makes the first click disappear.
  useEffect(() => {
    if (!isOpen || !usePortal) return;
    const handleScrollOrResize = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      updateDropdownPos();
    };
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [isOpen, usePortal, updateDropdownPos]);

  // Read selectedLabel via ref so the value-sync effect can inspect it without
  // depending on it (and re-firing in feedback loops with state it sets itself).
  const selectedLabelRef = useRef(selectedLabel);
  useEffect(() => {
    selectedLabelRef.current = selectedLabel;
  });

  // Find selected option label when value changes (only if not currently typing)
  /* eslint-disable react-hooks/set-state-in-effect -- syncing display state from prop changes */
  useEffect(() => {
    if (isTyping) return;

    if (value) {
      const option = options.find(opt => opt.value === value);
      if (option) {
        setSelectedLabel(option.label);
        setInputValue(option.label);
        setHasInitialized(true);
      } else if (initialDisplayValue && !hasInitialized) {
        // Option not found yet (options list still loading): show the caller's
        // display name, never the raw value -- for id-backed fields the raw
        // value is a UUID and must not flash in the input while lists load.
        setInputValue(initialDisplayValue);
        setSelectedLabel(initialDisplayValue);
      } else if (allowCustomValue && !valueIsId) {
        // Display the raw value for custom values not in options list. An
        // id-backed value stays blank instead until it resolves to a label.
        setSelectedLabel(value);
        setInputValue(value);
        setHasInitialized(true);
      }
    } else if (!allowCustomValue) {
      setSelectedLabel('');
      setInputValue('');
    } else if (initialDisplayValue && !hasInitialized) {
      // For custom values, use initial display value
      setInputValue(initialDisplayValue);
      setSelectedLabel(initialDisplayValue);
      setHasInitialized(true);
    } else if (selectedLabelRef.current && options.some(opt => opt.label === selectedLabelRef.current)) {
      // Programmatic clear: value is empty but the displayed label was a known
      // option (not a user-typed custom value), so sync the display to empty.
      setSelectedLabel('');
      setInputValue('');
    }
  }, [value, options, isTyping, allowCustomValue, valueIsId, initialDisplayValue, hasInitialized]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Lift the current typed text to the parent: snap to an exact option match if
  // one exists, otherwise commit it as a custom value. Shared by the
  // click-outside and Tab handlers so a freshly-typed value is never discarded
  // when focus leaves the field without explicitly picking a dropdown option.
  const commitTypedCustomValue = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    const matchedOption = options.find(
      (opt) => opt.label.toLowerCase() === trimmed.toLowerCase(),
    );
    if (matchedOption) {
      setSelectedLabel(matchedOption.label);
      setInputValue(matchedOption.label);
      onChange(matchedOption.value, matchedOption.label);
    } else if (trimmed !== selectedLabel) {
      setSelectedLabel(trimmed);
      onChange('', trimmed);
    }
  }, [inputValue, options, selectedLabel, onChange]);

  // Close dropdown when clicking outside. In portal mode the list renders
  // outside wrapperRef, so it is checked separately; otherwise it lives inside
  // the wrapper and the listRef check is harmlessly redundant.
  useClickOutside([wrapperRef, listRef], (event) => {
    setIsOpen(false);
    // Only process if user was actively typing AND the click is not on a form submit button
    // This prevents the click-outside handler from interfering with form submission
    const target = event.target as HTMLElement;
    const isSubmitButton = target.closest('button[type="submit"]');

    if (isTyping) {
      setIsTyping(false);

      if (!inputValue.trim()) {
        // User erased the text -- clear the selection
        if (selectedLabel) {
          setSelectedLabel('');
          setInputValue('');
          onChange('', '');
        }
      } else if (allowCustomValue) {
        // Commit the typed value -- even when the click lands on a submit button
        // -- so a freshly-typed custom value is lifted to the parent before the
        // form reads it. Snap to an exact option match when one exists.
        commitTypedCustomValue();
      } else if (!isSubmitButton && selectedLabel) {
        // Not allowing custom values: restore the committed label, but don't
        // fight a form submission already in progress.
        setInputValue(selectedLabel);
      }
    }
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Ignore input changes right after opening (caused by select())
    if (justOpenedRef.current) {
      return;
    }

    const newValue = e.target.value;
    setFilterText(newValue); // Track what user typed for filtering
    if (usePortal && !isOpen) updateDropdownPos();
    setIsOpen(true);
    setIsTyping(true);
    isNavigatingRef.current = false; // User is typing, not navigating

    if (onInputChange) {
      onInputChange(newValue);
    }

    setInputValue(newValue);
    isDeleteRef.current = false;
  };

  const handleSelectOption = (option: ComboboxOption) => {
    setInputValue(option.label);
    setSelectedLabel(option.label);
    setIsTyping(false);
    onChange(option.value, option.label);
    setIsOpen(false);
  };

  // Track if we just opened the dropdown to ignore immediate input changes
  const justOpenedRef = useRef(false);

  const openDropdown = () => {
    // Always reset to show all options when dropdown opens
    setFilterText('');
    setIsTyping(false);
    // Compute portal position before opening so dropdown renders in portal on first paint
    if (usePortal) updateDropdownPos();
    setIsOpen(true);
    isNavigatingRef.current = false;
    // Mark that we just opened - this prevents select() from triggering filter
    justOpenedRef.current = true;
    setTimeout(() => {
      justOpenedRef.current = false;
    }, 100);
  };

  const handleFocus = () => {
    // When openOnFocus is disabled, focusing the input (e.g. a modal
    // auto-focusing the first focusable element) must not open the dropdown;
    // it only opens on an explicit click, keypress, or typing.
    if (openOnFocus) openDropdown();
    // Select all text when focusing so user can easily type to filter
    if (inputRef.current && inputValue) {
      setTimeout(() => {
        inputRef.current?.select();
      }, 0);
    }
  };

  const handleClick = () => {
    // Handle click on already-focused input (onFocus won't fire again)
    // Always reset and open to show full list
    openDropdown();
  };

  // When dropdown is open and user is typing, filter by what they typed
  // Otherwise show all options. Prefix matches are sorted first for relevance.
  // When not filtering: priority values first, then alphabetical.
  const filteredOptions = (isTyping && filterText)
    ? options
        .filter(option =>
          option.label.toLowerCase().includes(filterText.toLowerCase()) ||
          (option.subtitle && option.subtitle.toLowerCase().includes(filterText.toLowerCase())) ||
          (option.keywords && option.keywords.some(kw => kw.toLowerCase().includes(filterText.toLowerCase())))
        )
        .sort((a, b) => {
          const lowerFilter = filterText.toLowerCase();
          const aPrefix = a.label.toLowerCase().startsWith(lowerFilter);
          const bPrefix = b.label.toLowerCase().startsWith(lowerFilter);
          if (aPrefix && !bPrefix) return -1;
          if (!aPrefix && bPrefix) return 1;
          return a.label.localeCompare(b.label);
        })
    : priorityValues && priorityValues.length > 0
      ? [...options].sort((a, b) => {
          const aIdx = priorityValues.indexOf(a.value);
          const bIdx = priorityValues.indexOf(b.value);
          const aIsPriority = aIdx !== -1;
          const bIsPriority = bIdx !== -1;
          if (aIsPriority && !bIsPriority) return -1;
          if (!aIsPriority && bIsPriority) return 1;
          if (aIsPriority && bIsPriority) return aIdx - bIdx;
          return a.label.localeCompare(b.label);
        })
      : options;

  // Check if input matches an existing option exactly
  const exactMatch = options.some(
    option => option.label.toLowerCase() === inputValue.toLowerCase()
  );

  // Show "Create new" option if custom values allowed and input doesn't match exactly (only when typing)
  const showCreateOption = allowCustomValue && isTyping && inputValue.trim() && !exactMatch;

  // Total number of items in the dropdown (create option counts as index 0 if shown)
  const totalItems = filteredOptions.length + (showCreateOption ? 1 : 0);

  // Find index of currently selected option to highlight it
  const selectedOptionIndex = filteredOptions.findIndex(opt => opt.value === value);

  // Reset highlighted index when dropdown opens or filter results change
  /* eslint-disable react-hooks/set-state-in-effect -- syncing UI state from derived values */
  useEffect(() => {
    if (isOpen) {
      if (isTyping && filteredOptions.length > 0) {
        // Only auto-highlight on new filter text, not during arrow key navigation
        if (!isNavigatingRef.current && filterText !== prevFilterTextRef.current) {
          setHighlightedIndex(showCreateOption ? 1 : 0);
        }
      } else if (!isTyping && selectedOptionIndex >= 0) {
        // If there's a selected value and we're not typing, highlight it
        setHighlightedIndex(showCreateOption ? selectedOptionIndex + 1 : selectedOptionIndex);
      } else {
        setHighlightedIndex(-1);
      }
    }
    prevFilterTextRef.current = filterText;
  }, [isOpen, isTyping, selectedOptionIndex, showCreateOption, filteredOptions.length, filterText]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Scroll highlighted/selected item into view when dropdown opens
  useEffect(() => {
    if (isOpen && listRef.current && selectedOptionIndex >= 0 && !isTyping) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        const items = listRef.current?.querySelectorAll('[data-option-index]');
        const targetIndex = showCreateOption ? selectedOptionIndex + 1 : selectedOptionIndex;
        const selectedItem = items?.[targetIndex] as HTMLElement;
        if (selectedItem) {
          selectedItem.scrollIntoView({ block: 'nearest' });
        }
      }, 0);
    }
  }, [isOpen, selectedOptionIndex, showCreateOption, isTyping]);

  // Scroll highlighted item into view during keyboard navigation
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-option-index]');
      const highlightedItem = items[highlightedIndex] as HTMLElement;
      if (highlightedItem) {
        highlightedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Track deletion keys to suppress inline autocomplete on backspace/delete
    if (e.key === 'Backspace' || e.key === 'Delete') {
      isDeleteRef.current = true;
    }

    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (usePortal) updateDropdownPos();
        setIsOpen(true);
        setHighlightedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        isNavigatingRef.current = true;
        setHighlightedIndex(prev =>
          prev < totalItems - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        isNavigatingRef.current = true;
        setHighlightedIndex(prev =>
          prev > 0 ? prev - 1 : prev
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0) {
          if (showCreateOption && highlightedIndex === 0) {
            handleCreateNew();
          } else {
            const optionIndex = showCreateOption ? highlightedIndex - 1 : highlightedIndex;
            if (optionIndex >= 0 && optionIndex < filteredOptions.length) {
              handleSelectOption(filteredOptions[optionIndex]);
            }
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setHighlightedIndex(-1);
        // Reset input to selected value
        if (selectedLabel) {
          setInputValue(selectedLabel);
        }
        setIsTyping(false);
        break;
      case 'Tab':
        // Accept the highlighted/autocompleted option on Tab, then let focus move naturally
        if (isTyping) {
          if (highlightedIndex >= 0) {
            if (showCreateOption && highlightedIndex === 0) {
              handleCreateNew();
            } else {
              const optionIndex = showCreateOption ? highlightedIndex - 1 : highlightedIndex;
              if (optionIndex >= 0 && optionIndex < filteredOptions.length) {
                handleSelectOption(filteredOptions[optionIndex]);
              }
            }
          } else if (allowCustomValue) {
            // No option highlighted: lift any typed custom value to the parent so
            // tabbing out of the field (instead of clicking away) doesn't discard
            // it -- otherwise the form reads a blank payee on submit.
            commitTypedCustomValue();
          }
        }
        setIsOpen(false);
        setIsTyping(false);
        // Don't prevent default - allow normal Tab navigation to next field
        break;
    }
  };

  const handleCreateNew = () => {
    const trimmedValue = inputValue.trim();
    if (onCreateNew) {
      // Let parent handle creation - it will update value/options
      onCreateNew(trimmedValue);
    } else {
      // Fallback: just pass the custom value
      onChange('', trimmedValue);
    }
    setSelectedLabel(trimmedValue);
    setIsTyping(false);
    setIsOpen(false);
  };

  const dropdownContent = (
    <div
      ref={listRef}
      className={cn(
        'bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 max-h-60 rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 dark:ring-gray-600 overflow-auto focus:outline-none sm:text-sm',
        usePortal ? 'fixed z-[100]' : 'absolute z-10 mt-1 w-full',
      )}
      style={usePortal && dropdownPos ? { top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width } : undefined}
    >
      {showCreateOption && (
        <div
          data-option-index="0"
          onClick={handleCreateNew}
          className={cn(
            'cursor-pointer select-none relative py-2 pl-3 pr-9 border-b border-gray-100 dark:border-gray-700',
            highlightedIndex === 0 ? 'bg-green-100 dark:bg-green-900' : 'hover:bg-green-50 dark:hover:bg-green-900/50'
          )}
        >
          <div className="flex items-center min-w-0">
            <span className="text-green-600 dark:text-green-400 mr-2 flex-shrink-0">+</span>
            {/* truncate, like every option row below: the dropdown is only as
                wide as its input, and a long name would otherwise overflow it
                -- worst in the transaction form, where the payee field gives up
                width to the history button. */}
            <span className="block truncate font-medium text-green-700 dark:text-green-300">
              {t('combobox.createOption', { value: inputValue.trim() })}
            </span>
          </div>
        </div>
      )}
      {filteredOptions.map((option, index) => {
        const optionIndex = showCreateOption ? index + 1 : index;
        const isSelected = option.value === value;
        const isHighlighted = highlightedIndex === optionIndex;
        return (
          <div
            key={option.value}
            data-option-index={optionIndex}
            onClick={() => handleSelectOption(option)}
            className={cn(
              'cursor-pointer select-none relative py-2 pl-3',
              onDeleteOption ? 'pr-16' : 'pr-9',
              isHighlighted ? 'bg-blue-100 dark:bg-blue-900' : 'hover:bg-blue-50 dark:hover:bg-blue-900/50',
              isSelected && !isHighlighted && 'bg-blue-50 dark:bg-blue-900/30'
            )}
          >
            <div className="flex flex-col">
              <span className={cn(
                'block truncate dark:text-gray-100',
                isSelected ? 'font-semibold' : 'font-medium'
              )}>
                {option.label}
              </span>
              {option.subtitle && (alwaysShowSubtitle || (isTyping && filterText)) && (
                <span className="text-gray-500 dark:text-gray-400 text-xs truncate">
                  {option.subtitle}
                </span>
              )}
              {isTyping && filterText && option.keywords && (() => {
                const lowerFilter = filterText.toLowerCase();
                const labelMatches = option.label.toLowerCase().includes(lowerFilter);
                if (labelMatches) return null;
                const matchedKeyword = option.keywords.find(kw => kw.toLowerCase().includes(lowerFilter));
                if (!matchedKeyword) return null;
                return (
                  <span className="text-purple-500 dark:text-purple-400 text-xs truncate">
                    alias: {matchedKeyword}
                  </span>
                );
              })()}
            </div>
            {onDeleteOption && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={
                  deleteOptionAriaLabel
                    ? `${deleteOptionAriaLabel}: ${option.label}`
                    : t('combobox.deleteOption', { value: option.label })
                }
                title={
                  deleteOptionAriaLabel ??
                  t('combobox.deleteOption', { value: option.label })
                }
                // Delete instead of select: mousedown is where the row's click
                // would otherwise begin, so stop it there as well.
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsOpen(false);
                  onDeleteOption(option.value, option.label);
                }}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
              >
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 012 0v7a1 1 0 11-2 0V8zm4-1a1 1 0 00-1 1v7a1 1 0 102 0V8a1 1 0 00-1-1zm4 1a1 1 0 112 0v7a1 1 0 11-2 0V8z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
            {isSelected && (
              <span
                className={cn(
                  'absolute inset-y-0 flex items-center text-blue-600 dark:text-blue-400',
                  onDeleteOption ? 'right-8 pr-1' : 'right-0 pr-4',
                )}
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderDropdown = () => {
    if (usePortal && dropdownPos) {
      return createPortal(dropdownContent, document.body);
    }
    return dropdownContent;
  };

  return (
    <div ref={wrapperRef} className="w-full relative">
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            inputBaseClasses,
            error && inputErrorClasses,
            inputValue && !disabled && 'pr-8'
          )}
        />
        {inputValue && !disabled && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault();
              setInputValue('');
              setSelectedLabel('');
              setFilterText('');
              setIsTyping(false);
              onChange('', '');
              inputRef.current?.focus();
            }}
            className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          </button>
        )}
        {isOpen && (filteredOptions.length > 0 || showCreateOption) && renderDropdown()}
      </div>
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
