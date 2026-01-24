'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface ComboboxOption {
  value: string;
  label: string;
  subtitle?: string;
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
}: ComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(initialDisplayValue || '');
  const [selectedLabel, setSelectedLabel] = useState(initialDisplayValue || '');
  const [isTyping, setIsTyping] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Find selected option label when value changes (only if not currently typing)
  useEffect(() => {
    if (isTyping) return;

    if (value) {
      const option = options.find(opt => opt.value === value);
      if (option) {
        setSelectedLabel(option.label);
        setInputValue(option.label);
        setHasInitialized(true);
      } else if (initialDisplayValue && !hasInitialized) {
        // Use initial display value if option not found yet (still loading)
        setInputValue(initialDisplayValue);
        setSelectedLabel(initialDisplayValue);
      }
    } else if (!allowCustomValue) {
      setSelectedLabel('');
      setInputValue('');
    } else if (initialDisplayValue && !hasInitialized) {
      // For custom values, use initial display value
      setInputValue(initialDisplayValue);
      setSelectedLabel(initialDisplayValue);
      setHasInitialized(true);
    }
  }, [value, options, isTyping, allowCustomValue, initialDisplayValue, hasInitialized]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const isInsideWrapper = wrapperRef.current && wrapperRef.current.contains(event.target as Node);

      if (!isInsideWrapper) {
        setIsOpen(false);

        // Only process if user was actively typing AND the click is not on a form submit button
        // This prevents the click-outside handler from interfering with form submission
        const target = event.target as HTMLElement;
        const isSubmitButton = target.closest('button[type="submit"]');

        if (isTyping && !isSubmitButton) {
          setIsTyping(false);

          // Reset to selected value if not allowing custom
          if (!allowCustomValue && selectedLabel) {
            setInputValue(selectedLabel);
          } else if (allowCustomValue && inputValue.trim()) {
            // For custom values, check if input matches an option exactly
            const matchedOption = options.find(
              opt => opt.label.toLowerCase() === inputValue.toLowerCase()
            );
            if (matchedOption) {
              // Select the matched option
              setSelectedLabel(matchedOption.label);
              setInputValue(matchedOption.label);
              onChange(matchedOption.value, matchedOption.label);
            } else if (inputValue.trim() !== selectedLabel) {
              // Only update if value actually changed
              setSelectedLabel(inputValue.trim());
              onChange('', inputValue.trim());
            }
          }
        } else if (isTyping && isSubmitButton) {
          // Just close and reset typing state without calling onChange
          setIsTyping(false);
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [selectedLabel, allowCustomValue, inputValue, options, onChange, isTyping]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
    setIsTyping(true);

    if (onInputChange) {
      onInputChange(newValue);
    }

    // Don't call onChange on every keystroke - wait for explicit selection
    // This prevents clearing the form value while the user is typing
  };

  const handleSelectOption = (option: ComboboxOption) => {
    setInputValue(option.label);
    setSelectedLabel(option.label);
    setIsTyping(false);
    onChange(option.value, option.label);
    setIsOpen(false);
  };

  const filteredOptions = options.filter(option =>
    option.label.toLowerCase().includes(inputValue.toLowerCase()) ||
    (option.subtitle && option.subtitle.toLowerCase().includes(inputValue.toLowerCase()))
  );

  // Check if input matches an existing option exactly
  const exactMatch = options.some(
    option => option.label.toLowerCase() === inputValue.toLowerCase()
  );

  // Show "Create new" option if custom values allowed and input doesn't match exactly
  const showCreateOption = allowCustomValue && inputValue.trim() && !exactMatch;

  // Total number of items in the dropdown (create option counts as index 0 if shown)
  const totalItems = filteredOptions.length + (showCreateOption ? 1 : 0);

  // Reset highlighted index when dropdown opens or options change
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(-1);
    }
  }, [isOpen, inputValue]);

  // Scroll highlighted item into view
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
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIsOpen(true);
        setHighlightedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev =>
          prev < totalItems - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
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

  return (
    <div ref={wrapperRef} className="w-full relative">
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            'block w-full rounded-md border-gray-300 shadow-sm',
            'focus:border-blue-500 focus:ring-blue-500',
            'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
            'dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400',
            'dark:focus:border-blue-400 dark:focus:ring-blue-400',
            'dark:disabled:bg-gray-700 dark:disabled:text-gray-400',
            error && 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-500'
          )}
        />
        {isOpen && (filteredOptions.length > 0 || showCreateOption) && (
          <div
            ref={listRef}
            className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 max-h-60 rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 dark:ring-gray-600 overflow-auto focus:outline-none sm:text-sm"
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
                <div className="flex items-center">
                  <span className="text-green-600 dark:text-green-400 mr-2">+</span>
                  <span className="font-medium text-green-700 dark:text-green-300">
                    Create "{inputValue.trim()}"
                  </span>
                </div>
              </div>
            )}
            {filteredOptions.map((option, index) => {
              const optionIndex = showCreateOption ? index + 1 : index;
              return (
                <div
                  key={option.value}
                  data-option-index={optionIndex}
                  onClick={() => handleSelectOption(option)}
                  className={cn(
                    'cursor-pointer select-none relative py-2 pl-3 pr-9',
                    highlightedIndex === optionIndex ? 'bg-blue-100 dark:bg-blue-900' : 'hover:bg-blue-50 dark:hover:bg-blue-900/50'
                  )}
                >
                  <div className="flex flex-col">
                    <span className="font-medium block truncate dark:text-gray-100">
                      {option.label}
                    </span>
                    {option.subtitle && (
                      <span className="text-gray-500 dark:text-gray-400 text-xs truncate">
                        {option.subtitle}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
