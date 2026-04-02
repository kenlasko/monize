import { ChangeEvent, forwardRef, InputHTMLAttributes, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from './Input';
import { getLocalDateString, formatDate, parseDateFromFormat } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';

interface DateInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  onDateChange?: (date: string) => void;
}

function parseOrToday(value: string): Date {
  if (value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

const tooltipContent = (
  <>
    <span className="block font-medium mb-1">Keyboard shortcuts</span>
    <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <kbd className="font-mono">T</kbd><span>Today</span>
      <kbd className="font-mono">Y</kbd><span>First day of year</span>
      <kbd className="font-mono">R</kbd><span>Last day of year</span>
      <kbd className="font-mono">M</kbd><span>First day of month</span>
      <kbd className="font-mono">H</kbd><span>Last day of month</span>
      <kbd className="font-mono">+</kbd><span>Next day</span>
      <kbd className="font-mono">-</kbd><span>Previous day</span>
      <kbd className="font-mono">PgUp</kbd><span>Previous month</span>
      <kbd className="font-mono">PgDn</kbd><span>Next month</span>
    </span>
  </>
);

function DateShortcutTooltip() {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
  }, []);

  const hideTooltip = useCallback(() => {
    setPosition(null);
  }, []);

  return (
    <span
      ref={iconRef}
      className="hidden sm:inline-flex items-center ml-1"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      <svg
        className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 cursor-help"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      {position && createPortal(
        <div
          role="tooltip"
          className="fixed -translate-x-1/2 px-3 py-2 text-xs font-normal text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg whitespace-nowrap z-[100] pointer-events-none"
          style={{ top: position.top, left: position.left }}
        >
          {tooltipContent}
        </div>,
        document.body,
      )}
    </span>
  );
}

// Resolves the computed date for a keyboard shortcut key.
// Returns null if the key is not a recognized shortcut.
function resolveShortcutDate(key: string, currentValue: string): Date | null {
  switch (key) {
    case 't':
    case 'T':
      return new Date();
    case 'y':
    case 'Y': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), 0, 1);
    }
    case 'r':
    case 'R': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), 11, 31);
    }
    case 'm':
    case 'M': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), d.getMonth(), 1);
    }
    case 'h':
    case 'H': {
      const d = parseOrToday(currentValue);
      // Day 0 of next month = last day of current month
      return new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }
    case '+':
    case '=': {
      const d = parseOrToday(currentValue);
      d.setDate(d.getDate() + 1);
      return d;
    }
    case '-': {
      const d = parseOrToday(currentValue);
      d.setDate(d.getDate() - 1);
      return d;
    }
    case 'PageUp': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), d.getMonth() - 1, 1);
    }
    case 'PageDown': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    default:
      return null;
  }
}

// React-controlled inputs ignore direct .value assignments.
// Use the native setter to bypass React and then dispatch a change event
// so that both react-hook-form register() and controlled onChange handlers work.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ onDateChange, onKeyDown, onChange: externalOnChange, onBlur: externalOnBlur, value: externalValue, label, id, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
    const { dateFormat } = useDateFormat();
    const useTextMode = dateFormat !== 'browser';

    // Internal YYYY-MM-DD value for text mode, kept in sync with externalValue
    const [isoValue, setIsoValue] = useState<string>((externalValue as string) || '');
    const [displayValue, setDisplayValue] = useState('');
    const isFocusedRef = useRef(false);

    // Sync external value changes to internal state
    useEffect(() => {
      if (!useTextMode) return;
      const newIso = (externalValue as string) || '';
      setIsoValue(newIso);
      if (!isFocusedRef.current) {
        setDisplayValue(newIso ? formatDate(newIso, dateFormat) : '');
      }
    }, [externalValue, dateFormat, useTextMode]);

    // Emit a YYYY-MM-DD value change through all relevant callbacks
    const emitDateChange = useCallback((dateStr: string) => {
      setIsoValue(dateStr);
      if (onDateChange) {
        onDateChange(dateStr);
      }
    }, [onDateChange]);

    // Keyboard shortcut handler (works in both modes)
    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
      const currentIso = useTextMode ? isoValue : e.currentTarget.value;
      const newDate = resolveShortcutDate(e.key, currentIso);

      if (newDate) {
        e.preventDefault();
        const dateStr = getLocalDateString(newDate);

        if (useTextMode) {
          setDisplayValue(formatDate(dateStr, dateFormat));
          emitDateChange(dateStr);
        } else if (onDateChange) {
          onDateChange(dateStr);
        } else {
          // For controlled components: set the native value and fire a change event
          nativeInputValueSetter?.call(e.currentTarget, dateStr);
          e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      onKeyDown?.(e);
    }, [useTextMode, isoValue, dateFormat, emitDateChange, onDateChange, onKeyDown]);

    // Text mode: handle user typing in the formatted input
    const handleTextChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setDisplayValue(text);

      const parsed = parseDateFromFormat(text, dateFormat);
      if (parsed) {
        emitDateChange(parsed);
      }
    }, [dateFormat, emitDateChange]);

    // Text mode: reformat on blur
    const handleTextBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
      isFocusedRef.current = false;
      // Try to parse whatever the user typed and reformat it
      const parsed = parseDateFromFormat(displayValue, dateFormat);
      if (parsed) {
        setDisplayValue(formatDate(parsed, dateFormat));
        emitDateChange(parsed);
      } else if (isoValue) {
        // Revert to the last valid formatted value
        setDisplayValue(formatDate(isoValue, dateFormat));
      }
      externalOnBlur?.(e);
    }, [displayValue, dateFormat, isoValue, emitDateChange, externalOnBlur]);

    const handleTextFocus = useCallback(() => {
      isFocusedRef.current = true;
    }, []);

    if (useTextMode) {
      return (
        <div className="w-full">
          {label && (
            <div className="flex items-center mb-1">
              <label
                htmlFor={inputId}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {label}
              </label>
              <DateShortcutTooltip />
            </div>
          )}
          <Input
            ref={ref}
            id={inputId}
            type="text"
            value={displayValue}
            onChange={handleTextChange}
            onBlur={handleTextBlur}
            onFocus={handleTextFocus}
            onKeyDown={handleKeyDown}
            placeholder={dateFormat}
            error={props.error}
            {...props}
          />
        </div>
      );
    }

    // Browser-format mode: use native date input (original behaviour)
    return (
      <div className="w-full">
        {label && (
          <div className="flex items-center mb-1">
            <label
              htmlFor={inputId}
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {label}
            </label>
            <DateShortcutTooltip />
          </div>
        )}
        <Input
          ref={ref}
          id={inputId}
          type="date"
          value={externalValue}
          onChange={externalOnChange}
          onBlur={externalOnBlur}
          onKeyDown={handleKeyDown}
          {...props}
        />
      </div>
    );
  }
);

DateInput.displayName = 'DateInput';
