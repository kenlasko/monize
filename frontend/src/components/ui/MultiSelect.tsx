'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  value: string;
  label: string;
  parentId?: string | null;  // For hierarchical options
  children?: MultiSelectOption[];  // Child options
}

interface MultiSelectProps {
  label?: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  showSearch?: boolean;
  error?: string;
  disabled?: boolean;
}

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select...',
  showSearch = true,
  error,
  disabled = false,
}: MultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
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

  // Select all / clear all
  const handleSelectAll = () => {
    const allValues = flatOptions.map(o => o.value);
    onChange(allValues);
  };

  const handleClearAll = () => {
    onChange([]);
  };

  // Filter options by search
  const filteredOptions = useMemo(() => {
    if (!searchText) return flatOptions;
    const searchLower = searchText.toLowerCase();
    return flatOptions.filter(opt =>
      opt.label.toLowerCase().includes(searchLower)
    );
  }, [flatOptions, searchText]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when opening
  useEffect(() => {
    if (isOpen && showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen, showSearch]);

  // Display text
  const displayText = useMemo(() => {
    if (value.length === 0) return placeholder;
    if (value.length === 1) {
      const opt = flatOptions.find(o => o.value === value[0]);
      return opt?.label || '1 selected';
    }
    return `${value.length} selected`;
  }, [value, flatOptions, placeholder]);

  const allSelected = value.length === flatOptions.length && flatOptions.length > 0;

  return (
    <div ref={wrapperRef} className="w-full relative">
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
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
          <svg
            className={cn(
              'h-5 w-5 text-gray-400 transition-transform',
              isOpen && 'rotate-180'
            )}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 rounded-md ring-1 ring-black ring-opacity-5 dark:ring-gray-600">
          {/* Search input */}
          {showSearch && (
            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
              <input
                ref={searchInputRef}
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Search..."
                className={cn(
                  'block w-full rounded-md border-gray-300 shadow-sm text-sm',
                  'focus:border-blue-500 focus:ring-blue-500',
                  'dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400'
                )}
              />
            </div>
          )}

          {/* Select All / Clear */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm">
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Clear
            </button>
          </div>

          {/* Options list */}
          <div className="max-h-[30rem] overflow-auto py-1">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                No options found
              </div>
            ) : (
              filteredOptions.map((option) => {
                const selectionState = getSelectionState(option.value, option.hasChildren);
                const isChecked = selectionState === 'all';
                const isIndeterminate = selectionState === 'some';

                // When searching, show parent name for context (flatten the hierarchy)
                const isSearching = searchText.length > 0;
                const parentLabel = option.parentValue ? optionMap.get(option.parentValue)?.label : null;

                return (
                  <label
                    key={option.value}
                    className={cn(
                      'flex items-center px-3 py-2 cursor-pointer',
                      'hover:bg-gray-100 dark:hover:bg-gray-700',
                      option.hasChildren && 'font-medium'
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
              })
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
