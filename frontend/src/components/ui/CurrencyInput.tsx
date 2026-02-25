'use client';

import { useState, useEffect, useRef, useCallback, useMemo, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { CalculatorIcon } from '@heroicons/react/24/outline';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { formatAmountWithCommas, formatAmount, parseAmount, filterCurrencyInput, filterCalculatorInput, hasCalculatorOperators, evaluateExpression } from '@/lib/format';
import { Modal } from './Modal';

const CALCULATOR_OPERATORS = [
  { label: '+', value: '+', ariaLabel: 'Add plus operator' },
  { label: '\u2212', value: '-', ariaLabel: 'Add minus operator' },
  { label: '\u00D7', value: '*', ariaLabel: 'Add multiply operator' },
  { label: '\u00F7', value: '/', ariaLabel: 'Add divide operator' },
] as const;

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
      disabled,
      ...props
    },
    ref
  ) => {
    // Local display state - allows free typing
    const [displayValue, setDisplayValue] = useState(() => formatAmountWithCommas(value));
    const [isFocused, setIsFocused] = useState(false);
    const [calcOpen, setCalcOpen] = useState(false);
    const [calcExpression, setCalcExpression] = useState('');

    const calcInputRef = useRef<HTMLInputElement>(null);
    const pendingCursorPos = useRef<number | null>(null);

    // Restore cursor position after React updates the DOM from operator insertion
    useEffect(() => {
      if (pendingCursorPos.current !== null && calcInputRef.current) {
        calcInputRef.current.setSelectionRange(pendingCursorPos.current, pendingCursorPos.current);
        pendingCursorPos.current = null;
      }
    });

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

    // --- Calculator modal logic ---

    const openCalculator = useCallback(() => {
      const initial = value !== undefined && value !== 0 ? formatAmount(value) : '';
      setCalcExpression(initial);
      setCalcOpen(true);
    }, [value]);

    const handleCalcExpressionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setCalcExpression(filterCalculatorInput(e.target.value));
    }, []);

    const insertOperator = useCallback((operator: string) => {
      const input = calcInputRef.current;
      if (!input) return;

      const start = input.selectionStart ?? calcExpression.length;
      const end = input.selectionEnd ?? calcExpression.length;

      const newValue = calcExpression.substring(0, start) + operator + calcExpression.substring(end);
      const filtered = filterCalculatorInput(newValue);

      setCalcExpression(filtered);
      pendingCursorPos.current = start + operator.length;
    }, [calcExpression]);

    const calcPreview = useMemo(() => {
      if (!hasCalculatorOperators(calcExpression)) {
        const parsed = parseAmount(calcExpression);
        if (parsed !== undefined) return formatAmountWithCommas(parsed);
        return null;
      }
      const result = evaluateExpression(calcExpression);
      if (result === undefined) return null;
      return formatAmountWithCommas(result);
    }, [calcExpression]);

    const applyCalculation = useCallback(() => {
      let result: number | undefined;
      if (hasCalculatorOperators(calcExpression)) {
        result = evaluateExpression(calcExpression);
      } else {
        result = parseAmount(calcExpression);
      }

      if (result !== undefined) {
        if (!allowNegative && result < 0) {
          result = Math.abs(result);
        }
        onChange(result);
        setDisplayValue(formatAmountWithCommas(result));
      }
      setCalcOpen(false);
    }, [calcExpression, allowNegative, onChange]);

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
        <div className="relative">
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
            disabled={disabled}
            style={{
              paddingLeft: prefix ? '1.75rem' : undefined,
              paddingRight: allowCalculator ? '2.25rem' : undefined,
            }}
            className={cn(
              inputBaseClasses,
              error && inputErrorClasses,
              className
            )}
            {...props}
          />
          {allowCalculator && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Open calculator"
              disabled={disabled}
              onClick={openCalculator}
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 disabled:pointer-events-none"
            >
              <CalculatorIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Calculator modal */}
        <Modal isOpen={calcOpen} onClose={() => setCalcOpen(false)} maxWidth="sm" pushHistory>
          <div className="p-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Calculator</h3>

            <input
              ref={calcInputRef}
              type="text"
              inputMode="decimal"
              autoFocus
              value={calcExpression}
              onChange={handleCalcExpressionChange}
              onKeyDown={(e) => { if (e.key === 'Enter') applyCalculation(); }}
              placeholder="e.g. 100*1.13"
              className={cn(inputBaseClasses, 'text-lg font-mono mb-3')}
            />

            <div className="flex items-center gap-1.5 mb-4">
              {CALCULATOR_OPERATORS.map(({ label: opLabel, value: opValue, ariaLabel }) => (
                <button
                  key={opValue}
                  type="button"
                  tabIndex={-1}
                  aria-label={ariaLabel}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertOperator(opValue);
                  }}
                  className="flex-1 py-2 text-base font-mono rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 active:bg-gray-200 dark:active:bg-gray-600 select-none transition-colors"
                >
                  {opLabel}
                </button>
              ))}
            </div>

            {calcPreview && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                = <span className="font-mono">{calcPreview}</span>
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCalcOpen(false)}
                className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyCalculation}
                disabled={!calcPreview}
                className="px-4 py-2 text-sm rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Apply
              </button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }
);

CurrencyInput.displayName = 'CurrencyInput';
