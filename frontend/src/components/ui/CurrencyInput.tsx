'use client';

import { useState, useEffect, useRef, useCallback, useMemo, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CalculatorIcon } from '@heroicons/react/24/outline';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { hasCalculatorOperators, evaluateExpression, roundToCents,
  roundToDecimals, } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  filterNumberTyping,
  formatAmountLocalized,
  formatNumberForEdit,
  normalizeExpression,
  parseLocaleNumber,
  stripGroupSeparator,
} from '@/lib/number-parse';
import { Modal } from './Modal';
import { Button } from './Button';

const CALCULATOR_OPERATORS = [
  { label: '+', value: '+', ariaLabel: 'Add plus operator' },
  { label: '\u2212', value: '-', ariaLabel: 'Add minus operator' },
  { label: '\u00D7', value: '*', ariaLabel: 'Add multiply operator' },
  { label: '\u00F7', value: '/', ariaLabel: 'Add divide operator' },
] as const;

interface CurrencyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  /** Currency minor-unit precision; existing forms default to two decimals. */
  decimalPlaces?: number;
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
  /** Show an in-field button to flip the value's sign (default: false) */
  allowSignToggle?: boolean;
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
      decimalPlaces = 2,
      error,
      prefix,
      value,
      onChange,
      allowNegative = true,
      allowCalculator = true,
      allowSignToggle = false,
      className,
      id,
      onBlur,
      onFocus,
      disabled,
      ...props
    },
    ref,
  ) => {
    const t = useTranslations('common');
    const nf = useNumberFormat();
    // Defensive default: a partial mock (or an older build mid rolling deploy)
    // may not carry the separators; en-US keeps the previous behaviour. Memoized
    // on the primitive fields, NOT the object identity: the real hook returns a
    // module-cached object (stable), but a partial test mock returns a fresh
    // literal each render -- keying on the strings keeps the reference stable
    // under both, so the callbacks below (and the sync effect that depends on
    // formatDisplay) do not rebuild every render.
    const sepDecimal = nf.numberSeparators?.decimal ?? '.';
    const sepGroup = nf.numberSeparators?.group ?? ',';
    const sepNativeDecimal = nf.numberSeparators?.nativeDecimal;
    const sepNativeGroup = nf.numberSeparators?.nativeGroup;
    const numberSeparators = useMemo(
      () => ({
        decimal: sepDecimal,
        group: sepGroup,
        ...(sepNativeDecimal ? { nativeDecimal: sepNativeDecimal } : {}),
        ...(sepNativeGroup ? { nativeGroup: sepNativeGroup } : {}),
      }),
      [sepDecimal, sepGroup, sepNativeDecimal, sepNativeGroup],
    );
    const numberLocale = nf.numberLocale;

    // Grouped, two-decimal display in the user's number locale -- the same
    // helper the read-only surfaces use, so the field and its labels agree.
    const formatDisplay = useCallback(
      (v: number | undefined | null): string =>
        // Latin digits: an editable field shows exactly the text it parses back.
        formatAmountLocalized(v,
          decimalPlaces, numberSeparators, numberLocale, { latnDigits: true },),
      [numberSeparators, numberLocale, decimalPlaces],
    );

    // Filter a raw string while typing, and parse it, in the user's convention.
    const filterTyping = useCallback(
      (raw: string): string =>
        filterNumberTyping(raw, {
          allowNegative: allowNegative || allowCalculator,
          allowOperators: allowCalculator,
          separators: numberSeparators,
        }),
      [allowNegative, allowCalculator, numberSeparators],
    );
    // Typed amounts and calculator results use the same selected minor unit.
    const parse = useCallback(
      (raw: string): number | undefined => {
        const n = parseLocaleNumber(raw, numberSeparators);
        return n === undefined ? undefined : decimalPlaces === 2
            ? roundToCents(n)
            : roundToDecimals(n, decimalPlaces);
      },
      [numberSeparators, decimalPlaces],
    );
    const evaluate = useCallback(
      (raw: string): number | undefined =>
        evaluateExpression(normalizeExpression(raw, numberSeparators), decimalPlaces),
      [numberSeparators, decimalPlaces],
    );

    // Local display state - allows free typing
    const [displayValue, setDisplayValue] = useState(() => formatDisplay(value));
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

    // Sync from parent when value changes externally (e.g., form reset), and
    // reformat if the number locale changes.
    useEffect(() => {
      if (!isFocused) {
        setDisplayValue(formatDisplay(value));
      }
    }, [value, isFocused, formatDisplay]);

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

    // Reserve right padding so typed text never runs under the in-field buttons.
    const rightButtonCount = (allowSignToggle ? 1 : 0) + (allowCalculator ? 1 : 0);
    const inputPaddingRight =
      rightButtonCount === 0 ? undefined : rightButtonCount === 1 ? '2.25rem' : '3.75rem';

    /**
     * Report a value only when it differs from the one the parent already
     * holds. Every path here re-parses whatever text is on screen, and for a
     * field nobody edited -- one tabbed through, or typed back to the same
     * number -- that text is the parent's own value formatted to two decimals.
     * Handing it back is not an edit. It is invisible to a parent that only
     * stores the number and destructive to one that does more: the FX panels
     * derive an exchange rate from the converted total and mark it
     * user-overridden, so a bare blur replaced a fetched 10dp rate with one
     * reverse-engineered from the cents-rounded total (1.365234 -> 1.365250)
     * and stopped the date effect re-fetching. A held value with more
     * precision than the display is the same case: its text is its display.
     */
    const notifyIfChanged = (next: number | undefined) => {
      if (next === value) return;
      // The field shows two decimals, and a stored four-decimal value (-3.3333)
      // re-parses as its display (-3.33): the same field untouched, not an
      // edit. Reporting it re-amounted the row on every cosmetic save.
      if (next !== undefined && value !== undefined &&
        roundToDecimals(value, decimalPlaces) === next) return;
      onChange(next);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      // Filter in the user's convention: keep their decimal separator, drop
      // their grouping separator, keep operators when the calculator is on.
      const filtered = filterTyping(e.target.value);

      setDisplayValue(filtered);

      // Only notify parent immediately if not a calculator expression
      // (expressions are evaluated on blur)
      if (!allowCalculator || !hasCalculatorOperators(filtered)) {
        notifyIfChanged(parse(filtered));
      }
    };

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      let finalValue: number | undefined;

      // Check if this is a calculator expression
      if (allowCalculator && hasCalculatorOperators(displayValue)) {
        // Evaluate the expression
        finalValue = evaluate(displayValue);

        // Apply negative restriction to the result
        if (finalValue !== undefined && !allowNegative && finalValue < 0) {
          finalValue = Math.abs(finalValue);
        }
      } else {
        // Standard parsing
        finalValue = parse(displayValue);
      }

      // Format and update
      if (finalValue !== undefined) {
        // If only the sign differs (same magnitude), preserve the parent's value
        // This prevents blur from undoing programmatic sign changes (e.g., category auto-sign)
        if (value !== undefined &&
            Math.abs(finalValue) === Math.abs(value) &&
            finalValue !== value) {
          setDisplayValue(formatDisplay(value));
        } else {
          setDisplayValue(formatDisplay(finalValue));
          notifyIfChanged(finalValue);
        }
      } else if (displayValue.trim() === '') {
        setDisplayValue('');
        notifyIfChanged(undefined);
      } else {
        // Invalid input - reset to last valid value
        setDisplayValue(formatDisplay(value));
      }

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      // When the user presses Enter on a calculator expression like "44*1.13",
      // evaluate it in place rather than letting the form submit. This lets
      // users do math inline without triggering validation prematurely.
      if (
        e.key === 'Enter' &&
        allowCalculator &&
        hasCalculatorOperators(displayValue)
      ) {
        e.preventDefault();
        let result = evaluate(displayValue);
        if (result !== undefined) {
          if (!allowNegative && result < 0) {
            result = Math.abs(result);
          }
          setDisplayValue(formatDisplay(result));
          notifyIfChanged(result);
        }
      }
    };

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      // Strip the grouping separator for easier editing, and clear if zero.
      const zero = formatNumberForEdit(0, decimalPlaces, numberSeparators);
      setDisplayValue(prev => {
        const stripped = stripGroupSeparator(prev, numberSeparators);
        return stripped === zero || stripped === '0' ? '' : stripped;
      });
      onFocus?.(e);
    };

    // Flip the value's sign. For a defined, non-zero value we notify the parent
    // with the negated number and let the sync effects update the display. When
    // empty or zero there is no magnitude yet, so we just flip the leading minus
    // on the display text so a subsequently typed number takes the chosen sign.
    const toggleSign = () => {
      if (value !== undefined && value !== 0) {
        onChange(-value);
        return;
      }
      setDisplayValue(prev => (prev.startsWith('-') ? prev.replace(/^-/, '') : '-' + prev));
    };

    // --- Calculator modal logic ---

    const openCalculator = useCallback(() => {
      const initial = value !== undefined && value !== 0 ? formatNumberForEdit(value, decimalPlaces, numberSeparators) : '';
      setCalcExpression(initial);
      setCalcOpen(true);
    }, [value, numberSeparators, decimalPlaces]);

    const handleCalcExpressionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setCalcExpression(filterTyping(e.target.value));
    }, [filterTyping]);

    const insertOperator = useCallback((operator: string) => {
      const input = calcInputRef.current;
      if (!input) return;

      const start = input.selectionStart ?? calcExpression.length;
      const end = input.selectionEnd ?? calcExpression.length;

      const newValue = calcExpression.substring(0, start) + operator + calcExpression.substring(end);
      const filtered = filterTyping(newValue);

      setCalcExpression(filtered);
      pendingCursorPos.current = start + operator.length;
    }, [calcExpression, filterTyping]);

    const calcPreview = useMemo(() => {
      if (!hasCalculatorOperators(calcExpression)) {
        const parsed = parse(calcExpression);
        if (parsed !== undefined) return formatDisplay(parsed);
        return null;
      }
      const result = evaluate(calcExpression);
      if (result === undefined) return null;
      return formatDisplay(result);
    }, [calcExpression, parse, evaluate, formatDisplay]);

    const applyCalculation = useCallback(() => {
      let result: number | undefined;
      if (hasCalculatorOperators(calcExpression)) {
        result = evaluate(calcExpression);
      } else {
        result = parse(calcExpression);
      }

      if (result !== undefined) {
        if (!allowNegative && result < 0) {
          result = Math.abs(result);
        }
        onChange(result);
        setDisplayValue(formatDisplay(result));
      }
      setCalcOpen(false);
    }, [calcExpression, allowNegative, onChange, parse, evaluate, formatDisplay]);

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
            placeholder={formatNumberForEdit(0, decimalPlaces, numberSeparators)}
            value={displayValue}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            style={{
              paddingLeft: prefix ? `${1.15 + prefix.length * 0.6}rem` : undefined,
              paddingRight: inputPaddingRight,
            }}
            className={cn(
              inputBaseClasses,
              error && inputErrorClasses,
              className
            )}
            {...props}
          />
          {rightButtonCount > 0 && (
            <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 gap-1.5">
              {allowSignToggle && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('currencyInput.toggleSign')}
                  disabled={disabled}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleSign();
                  }}
                  className="flex items-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 disabled:pointer-events-none"
                >
                  {/* Drawn rather than using the '±' glyph, which renders a
                      squat plus crowded against the minus in most fonts. */}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M12 3v11M6.5 8.5h11M6.5 20h11" />
                  </svg>
                </button>
              )}
              {allowCalculator && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('currencyInput.openCalculator')}
                  disabled={disabled}
                  onClick={openCalculator}
                  className="flex items-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 disabled:pointer-events-none"
                >
                  <CalculatorIcon className="h-5 w-5" />
                </button>
              )}
            </div>
          )}
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Calculator modal */}
        <Modal
          isOpen={calcOpen}
          onClose={() => setCalcOpen(false)}
          maxWidth="sm"
          pushHistory
          title={t('currencyInput.calculator')}
          padding="md"
          footer={
            <>
              <Button variant="outline" onClick={() => setCalcOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={applyCalculation} disabled={!calcPreview}>
                {t('currencyInput.apply')}
              </Button>
            </>
          }
        >
          <div>
            <input
              ref={calcInputRef}
              type="text"
              inputMode="decimal"
              autoFocus
              value={calcExpression}
              onChange={handleCalcExpressionChange}
              onKeyDown={(e) => { if (e.key === 'Enter') applyCalculation(); }}
              placeholder={`100*${formatNumberForEdit(1.13, 2, numberSeparators)}`}
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
              <p className="text-sm text-gray-500 dark:text-gray-400">
                = <span className="font-mono">{calcPreview}</span>
              </p>
            )}
          </div>
        </Modal>
      </div>
    );
  },
);

CurrencyInput.displayName = 'CurrencyInput';
