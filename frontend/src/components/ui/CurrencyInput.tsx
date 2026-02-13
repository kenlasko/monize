'use client';

import { useState, useEffect, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { formatAmountWithCommas, parseAmount, filterCurrencyInput, filterCalculatorInput, hasCalculatorOperators, evaluateExpression } from '@/lib/format';

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
  /** Allow calculator expressions like "100*1.13" (default: true) */
  allowCalculator?: boolean;
}

/**
 * Currency input component that handles:
 * - Formatting to 2 decimal places on blur
 * - Free editing while focused (can delete trailing zeros)
 * - Filtering non-numeric characters
 * - Proper rounding to cents
 * - Calculator expressions (e.g., "100*1.13" for tax calculations)
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
      allowCalculator = true,
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

    // Sync sign from parent value while focused (e.g., category auto-sign sets negative)
    useEffect(() => {
      if (isFocused && value !== undefined && value !== 0) {
        const isDisplayNeg = displayValue.startsWith('-');
        const isValueNeg = value < 0;
        if (isDisplayNeg !== isValueNeg) {
          setDisplayValue(prev => {
            const stripped = prev.replace(/^-/, '');
            return isValueNeg ? '-' + stripped : stripped;
          });
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const inputId = id || `input-${label?.toLowerCase().replace(/\s+/g, '-')}`;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      // Use calculator filter if calculator is enabled, otherwise standard currency filter
      let filtered = allowCalculator
        ? filterCalculatorInput(e.target.value)
        : filterCurrencyInput(e.target.value);

      // Remove minus sign if negative not allowed (but keep for expressions like "100-10")
      if (!allowNegative && !allowCalculator) {
        filtered = filtered.replace(/-/g, '');
      }

      setDisplayValue(filtered);

      // Only notify parent immediately if not a calculator expression
      // (expressions are evaluated on blur)
      if (!allowCalculator || !hasCalculatorOperators(filtered)) {
        const parsed = parseAmount(filtered);
        onChange(parsed);
      }
    };

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      let finalValue: number | undefined;

      // Check if this is a calculator expression
      if (allowCalculator && hasCalculatorOperators(displayValue)) {
        // Evaluate the expression
        finalValue = evaluateExpression(displayValue);

        // Apply negative restriction to the result
        if (finalValue !== undefined && !allowNegative && finalValue < 0) {
          finalValue = Math.abs(finalValue);
        }
      } else {
        // Standard parsing
        finalValue = parseAmount(displayValue);
      }

      // Format and update
      if (finalValue !== undefined) {
        // If only the sign differs (same magnitude), preserve the parent's value
        // This prevents blur from undoing programmatic sign changes (e.g., category auto-sign)
        if (value !== undefined &&
            Math.abs(finalValue) === Math.abs(value) &&
            finalValue !== value) {
          setDisplayValue(formatAmountWithCommas(value));
        } else {
          setDisplayValue(formatAmountWithCommas(finalValue));
          onChange(finalValue);
        }
      } else if (displayValue.trim() === '') {
        setDisplayValue('');
        onChange(undefined);
      } else {
        // Invalid input - reset to last valid value
        setDisplayValue(formatAmountWithCommas(value));
      }

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      // Strip commas when focused for easier editing, and clear if zero
      setDisplayValue(prev => {
        const stripped = prev.replace(/,/g, '');
        return stripped === '0.00' || stripped === '0' ? '' : stripped;
      });
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
            <span className="absolute inset-y-0 left-0 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none" style={{ paddingLeft: '0.75rem' }}>
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
            style={prefix ? { paddingLeft: '1.75rem' } : undefined}
            className={cn(
              inputBaseClasses,
              error && inputErrorClasses,
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
