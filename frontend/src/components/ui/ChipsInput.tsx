'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface ChipsInputOption {
  value: string;
  label: string;
}

interface ChipsInputProps {
  label?: string;
  options: ChipsInputOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}

export function ChipsInput({
  label,
  options,
  value,
  onChange,
  placeholder = 'Search and select...',
  error,
  disabled = false,
}: ChipsInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Get selected options with full info
  const selectedOptions = useMemo(() => {
    return value
      .map(v => options.find(o => o.value === v))
      .filter((o): o is ChipsInputOption => o !== undefined);
  }, [value, options]);

  // Filter available options (exclude already selected)
  const availableOptions = useMemo(() => {
    const selectedSet = new Set(value);
    return options
      .filter(o => !selectedSet.has(o.value))
      .filter(o => {
        if (!searchText) return true;
        return o.label.toLowerCase().includes(searchText.toLowerCase());
      });
  }, [options, value, searchText]);

  // Handle adding an option
  const handleAdd = (optionValue: string) => {
    if (!value.includes(optionValue)) {
      onChange([...value, optionValue]);
    }
    // Keep search text to allow selecting multiple items from filtered results
    setHighlightedIndex(-1);
    inputRef.current?.focus();
  };

  // Handle removing an option
  const handleRemove = (optionValue: string) => {
    onChange(value.filter(v => v !== optionValue));
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !searchText && value.length > 0) {
      // Remove last chip when backspace on empty input
      handleRemove(value[value.length - 1]);
      return;
    }

    if (!isOpen || availableOptions.length === 0) {
      if (e.key === 'ArrowDown' && availableOptions.length > 0) {
        setIsOpen(true);
        setHighlightedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev =>
          prev < availableOptions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => prev > 0 ? prev - 1 : prev);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < availableOptions.length) {
          handleAdd(availableOptions[highlightedIndex].value);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll('[data-option]');
      const highlightedItem = items[highlightedIndex] as HTMLElement;
      if (highlightedItem) {
        highlightedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset highlighted index when options change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchText]);

  return (
    <div ref={wrapperRef} className="w-full relative">
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}

      {/* Input container with chips */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-1 min-h-[38px] rounded-md border border-gray-300 shadow-sm px-2 py-1',
          'focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500',
          'dark:bg-gray-800 dark:border-gray-600',
          'dark:focus-within:border-blue-400 dark:focus-within:ring-blue-400',
          disabled && 'cursor-not-allowed bg-gray-50 dark:bg-gray-700',
          error && 'border-red-300 focus-within:border-red-500 focus-within:ring-red-500 dark:border-red-500'
        )}
        onClick={() => !disabled && inputRef.current?.focus()}
      >
        {/* Selected chips */}
        {selectedOptions.map(option => (
          <span
            key={option.value}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-sm',
              'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
            )}
          >
            <span className="truncate max-w-[150px]">{option.label}</span>
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(option.value);
                }}
                className="flex-shrink-0 hover:text-blue-600 dark:hover:text-blue-100"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
          </span>
        ))}

        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          className={cn(
            'flex-1 min-w-[100px] border-none outline-none bg-transparent p-1 text-sm',
            'placeholder:text-gray-400 dark:placeholder:text-gray-500',
            'dark:text-gray-100'
          )}
        />
      </div>

      {/* Dropdown */}
      {isOpen && availableOptions.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 max-h-60 rounded-md py-1 ring-1 ring-black ring-opacity-5 dark:ring-gray-600 overflow-auto"
        >
          {availableOptions.map((option, index) => (
            <div
              key={option.value}
              data-option
              onClick={() => handleAdd(option.value)}
              className={cn(
                'cursor-pointer select-none relative py-2 px-3 text-sm',
                highlightedIndex === index
                  ? 'bg-blue-100 dark:bg-blue-900'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700',
                'text-gray-900 dark:text-gray-100'
              )}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}

      {/* No results message */}
      {isOpen && searchText && availableOptions.length === 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 rounded-md py-2 px-3 ring-1 ring-black ring-opacity-5 dark:ring-gray-600">
          <span className="text-sm text-gray-500 dark:text-gray-400">No results found</span>
        </div>
      )}

      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
