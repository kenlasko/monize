'use client';

import { useState, useEffect, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { cn } from '@/lib/utils';
import { formatAmount, formatAmountWithCommas, parseAmount, filterCurrencyInput } from '@/lib/format';

interface CurrencyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  label?: string;
  error?: string;
  prefix?: string;
  /** The numeric value (can be undefined for empty) */
  value: number | undefined;
  /** Called when the value changes (after parsing and rounding) */
  onChange: (value: number | undefined) => void;
  /** Allow negative values (default: true) */
  allowNegative?: boolean;
}

/**
 * Currency input component that handles:
 * - Formatting to 2 decimal places on blur
 * - Free editing while focused (can delete trailing zeros)
 * - Filtering non-numeric characters
 * - Proper rounding to cents
 */
export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  (
    {
      label,
      error,
      prefix,
      value,
      onChange,
      allowNegative = true,
      className,
      id,
      onBlur,
      onFocus,
      ...props
    },
    ref
  ) => {
    // Local display state - allows free typing
    const [displayValue, setDisplayValue] = useState(() => formatAmountWithCommas(value));
    const [isFocused, setIsFocused] = useState(false);

    // Sync from parent when value changes externally (e.g., form reset)
    useEffect(() => {
      if (!isFocused) {
        setDisplayValue(formatAmountWithCommas(value));
      }
    }, [value, isFocused]);

    const inputId = id || `input-${label?.toLowerCase().replace(/\s+/g, '-')}`;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let filtered = filterCurrencyInput(e.target.value);

      // Remove minus sign if negative not allowed
      if (!allowNegative) {
        filtered = filtered.replace(/-/g, '');
      }

      setDisplayValue(filtered);

      // Parse and notify parent
      const parsed = parseAmount(filtered);
      onChange(parsed);
    };

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      // Format to 2 decimal places with commas on blur
      const parsed = parseAmount(displayValue);
      if (parsed !== undefined) {
        setDisplayValue(formatAmountWithCommas(parsed));
      } else if (displayValue.trim() === '') {
        setDisplayValue('');
      } else {
        // Invalid input - reset to last valid value
        setDisplayValue(formatAmountWithCommas(value));
      }

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      // Strip commas when focused for easier editing
      setDisplayValue(prev => prev.replace(/,/g, ''));
      onFocus?.(e);
    };

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {label}
          </label>
        )}
        <div className={prefix ? 'relative' : undefined}>
          {prefix && (
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={displayValue}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            className={cn(
              'block w-full rounded-md border-gray-300 shadow-sm',
              'focus:border-blue-500 focus:ring-blue-500',
              'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
              'dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400',
              'dark:focus:border-blue-400 dark:focus:ring-blue-400',
              'dark:disabled:bg-gray-700 dark:disabled:text-gray-400',
              error && 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-500',
              prefix && 'pl-7',
              className
            )}
            {...props}
          />
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }
);

CurrencyInput.displayName = 'CurrencyInput';
