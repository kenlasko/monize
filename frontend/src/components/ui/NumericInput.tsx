'use client';

import { useState, useEffect, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';

interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  label?: string;
  error?: string;
  prefix?: string;
  suffix?: string;
  /** The numeric value (can be undefined for empty) */
  value: number | undefined;
  /** Called when the value changes (after parsing) */
  onChange: (value: number | undefined) => void;
  /** Maximum decimal places allowed (default: 2) */
  decimalPlaces?: number;
  /** Allow negative values (default: false) */
  allowNegative?: boolean;
  /** Minimum value allowed */
  min?: number;
}

/**
 * Numeric input component that handles:
 * - Filtering non-numeric characters
 * - Configurable decimal places
 * - Formatting on blur
 * - Optional min value validation
 */
export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(
  (
    {
      label,
      error,
      prefix,
      suffix,
      value,
      onChange,
      decimalPlaces = 2,
      allowNegative = false,
      min,
      className,
      id,
      onBlur,
      onFocus,
      ...props
    },
    ref
  ) => {
    // Format value to specified decimal places
    function formatValue(val: number | undefined | null, decimals: number): string {
      if (val === undefined || val === null || isNaN(val)) {
        return '';
      }
      return val.toFixed(decimals);
    }

    // Local display state - allows free typing
    const [displayValue, setDisplayValue] = useState(() => formatValue(value, decimalPlaces));
    const [isFocused, setIsFocused] = useState(false);

    // Round to specified decimal places
    function roundToDecimals(val: number, decimals: number): number {
      const multiplier = Math.pow(10, decimals);
      return Math.round(val * multiplier) / multiplier;
    }

    // Parse input string to number
    function parseValue(input: string): number | undefined {
      const filtered = input.replace(/[^0-9.-]/g, '');
      if (filtered === '' || filtered === '-' || filtered === '.') {
        return undefined;
      }
      const parsed = parseFloat(filtered);
      if (isNaN(parsed)) {
        return undefined;
      }
      return roundToDecimals(parsed, decimalPlaces);
    }

    // Sync from parent when value changes externally (e.g., form reset)
    /* eslint-disable react-hooks/set-state-in-effect -- syncing display from prop changes */
    useEffect(() => {
      if (!isFocused) {
        setDisplayValue(formatValue(value, decimalPlaces));
      }
    }, [value, isFocused, decimalPlaces]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const inputId = id || `input-${label?.toLowerCase().replace(/\s+/g, '-')}`;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      // Filter to only valid characters
      let filtered = e.target.value.replace(/[^0-9.-]/g, '');

      // Remove minus sign if negative not allowed
      if (!allowNegative) {
        filtered = filtered.replace(/-/g, '');
      }

      // Limit decimal places while typing
      const parts = filtered.split('.');
      if (parts.length > 1 && parts[1].length > decimalPlaces) {
        filtered = parts[0] + '.' + parts[1].slice(0, decimalPlaces);
      }

      setDisplayValue(filtered);

      // Parse and notify parent
      const parsed = parseValue(filtered);

      // Apply min validation if specified
      if (parsed !== undefined && min !== undefined && parsed < min) {
        onChange(min);
      } else {
        onChange(parsed);
      }
    };

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      // Format to specified decimal places on blur
      const parsed = parseValue(displayValue);
      if (parsed !== undefined) {
        // Apply min validation
        const finalValue = min !== undefined && parsed < min ? min : parsed;
        setDisplayValue(formatValue(finalValue, decimalPlaces));
        onChange(finalValue);
      } else if (displayValue.trim() === '') {
        setDisplayValue('');
      } else {
        // Invalid input - reset to last valid value
        setDisplayValue(formatValue(value, decimalPlaces));
      }

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const hasAdornment = prefix || suffix;

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
        <div className={hasAdornment ? 'relative' : undefined}>
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
            placeholder={`0.${'0'.repeat(decimalPlaces)}`}
            value={displayValue}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            style={{
              ...(prefix ? { paddingLeft: '1.75rem' } : {}),
              ...(suffix ? { paddingRight: '3rem' } : {}),
            }}
            className={cn(
              inputBaseClasses,
              error && inputErrorClasses,
              className
            )}
            {...props}
          />
          {suffix && (
            <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none">
              {suffix}
            </span>
          )}
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }
);

NumericInput.displayName = 'NumericInput';
