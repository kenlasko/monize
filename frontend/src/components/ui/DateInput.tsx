import { ChangeEvent, forwardRef, InputHTMLAttributes, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from './Input';
import { CalendarPopover } from './CalendarPopover';
import { cn, getLocalDateString, formatDate, parseDateFromFormat, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
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
      <kbd className="font-mono">PgUp</kbd><span>Next month</span>
      <kbd className="font-mono">PgDn</kbd><span>Previous month</span>
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
      return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    case 'PageDown': {
      const d = parseOrToday(currentValue);
      return new Date(d.getFullYear(), d.getMonth() - 1, 1);
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

// Checks if a string looks like a YYYY-MM-DD date
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

const calendarIconSvg = (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
  </svg>
);

type InputMode = 'desktop-formatted' | 'desktop-browser' | 'touch-formatted' | 'touch-browser';

function getInputMode(dateFormat: string): InputMode {
  const touch = isTouchDevice();
  if (dateFormat === 'browser') return touch ? 'touch-browser' : 'desktop-browser';
  return touch ? 'touch-formatted' : 'desktop-formatted';
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ onDateChange, onKeyDown, onChange: externalOnChange, onBlur: externalOnBlur, value: externalValue, label, id, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
    const { dateFormat } = useDateFormat();
    const mode = getInputMode(dateFormat);

    // Internal YYYY-MM-DD value for desktop and touch-formatted modes
    const [isoValue, setIsoValue] = useState<string>((externalValue as string) || '');
    const [displayValue, setDisplayValue] = useState(() => {
      const val = (externalValue as string) || '';
      return val ? formatDate(val, dateFormat) : '';
    });
    const isFocusedRef = useRef(false);
    const localRef = useRef<HTMLInputElement>(null);
    // Hidden native date input ref for touch-formatted mode
    const nativeDateRef = useRef<HTMLInputElement>(null);

    // Merged ref: forwards to external ref (react-hook-form register) and keeps
    // a local reference for reading the DOM value
    const mergedRef = useCallback((node: HTMLInputElement | null) => {
      localRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
    }, [ref]);

    // On mount in formatted modes, read the initial value from the DOM.
    // react-hook-form sets defaultValues through the ref after mount, so we
    // use a microtask to let it complete before reading.
    useEffect(() => {
      if (mode === 'touch-browser' || mode === 'desktop-browser') return;
      // If we already have a value from props, nothing to do
      if (externalValue) return;

      const readDomValue = () => {
        const node = localRef.current;
        if (!node) return;
        const domVal = node.value;
        if (domVal && isIsoDate(domVal)) {
          setIsoValue(domVal);
          setDisplayValue(formatDate(domVal, dateFormat));
        }
      };

      // Try immediately (react-hook-form may have set value synchronously in ref)
      readDomValue();

      // Also try after a microtask (react-hook-form may set value in an effect)
      const timer = setTimeout(readDomValue, 0);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, dateFormat]);

    // Sync explicit value prop changes to internal state
    useEffect(() => {
      if (mode === 'touch-browser') return;
      const newIso = (externalValue as string) || '';
      if (!newIso) return;
      setIsoValue(newIso);
      if (!isFocusedRef.current) {
        setDisplayValue(formatDate(newIso, dateFormat));
      }
    }, [externalValue, dateFormat, mode]);

    // Emit a YYYY-MM-DD value change through all relevant callbacks
    const emitDateChange = useCallback((dateStr: string) => {
      setIsoValue(dateStr);
      setDisplayValue(formatDate(dateStr, dateFormat));
      if (onDateChange) {
        onDateChange(dateStr);
      }
    }, [onDateChange, dateFormat]);

    // Keyboard shortcut handler (works in all modes)
    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
      const isFormatted = mode === 'desktop-formatted' || mode === 'touch-formatted';
      const currentIso = isFormatted ? isoValue : e.currentTarget.value;
      const newDate = resolveShortcutDate(e.key, currentIso);

      if (newDate) {
        e.preventDefault();
        const dateStr = getLocalDateString(newDate);

        if (isFormatted) {
          emitDateChange(dateStr);
        } else if (onDateChange) {
          onDateChange(dateStr);
        } else {
          nativeInputValueSetter?.call(e.currentTarget, dateStr);
          e.currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      onKeyDown?.(e);
    }, [mode, isoValue, emitDateChange, onDateChange, onKeyDown]);

    // Desktop text mode: handle user typing in the formatted input
    const _handleTextChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setDisplayValue(text);

      const parsed = parseDateFromFormat(text, dateFormat);
      if (parsed) {
        emitDateChange(parsed);
      }
      // Also forward to external onChange for components that listen to it directly
      externalOnChange?.(e);
    }, [dateFormat, emitDateChange, externalOnChange]);

    // Desktop text mode: reformat on blur
    const _handleTextBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
      isFocusedRef.current = false;
      const parsed = parseDateFromFormat(displayValue, dateFormat);
      if (parsed) {
        setDisplayValue(formatDate(parsed, dateFormat));
        emitDateChange(parsed);
      } else if (isoValue) {
        setDisplayValue(formatDate(isoValue, dateFormat));
      }
      externalOnBlur?.(e);
    }, [displayValue, dateFormat, isoValue, emitDateChange, externalOnBlur]);

    const _handleTextFocus = useCallback(() => {
      isFocusedRef.current = true;
    }, []);

    // Desktop: toggle custom calendar popover
    const [showCalendar, setShowCalendar] = useState(false);
    const calendarAnchorRef = useRef<HTMLDivElement>(null);

    const handleCalendarClick = useCallback(() => {
      setShowCalendar((prev) => !prev);
    }, []);

    const _handleCalendarSelect = useCallback((date: string) => {
      if (date) {
        emitDateChange(date);
      }
    }, [emitDateChange]);

    const handleCalendarClose = useCallback(() => {
      setShowCalendar(false);
    }, []);

    // Touch mode: handle native picker selection
    const handleNativeDateChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (val && isIsoDate(val)) {
        emitDateChange(val);
      }
    }, [emitDateChange]);

    const labelBlock = label && (
      <div className="flex items-center mb-1">
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {label}
        </label>
        <DateShortcutTooltip />
      </div>
    );

    // --- Touch + custom format mode ---
    // The user sees the date in their preferred format, but the actual
    // interactive element is a transparent native date input layered on top.
    // Letting the user tap directly into the native input is the only reliable
    // way to open the picker on iPad WebKit -- programmatic showPicker() on a
    // hidden input fails silently there.
    if (mode === 'touch-formatted') {
      return (
        <div className="w-full">
          {labelBlock}
          <div className="relative">
            {/* Visible formatted display, decorative only */}
            <div
              aria-hidden="true"
              className={cn(
                inputBaseClasses,
                'border px-3 py-2 pr-10 min-h-[42px] flex items-center',
                'focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500',
                props.error && inputErrorClasses,
                !displayValue && 'text-gray-400 dark:text-gray-500',
              )}
            >
              {displayValue || dateFormat}
            </div>
            {/* Calendar icon overlay (visual only, taps pass through) */}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 right-3 flex items-center text-gray-400 dark:text-gray-500 pointer-events-none"
            >
              {calendarIconSvg}
            </span>
            {/* Native date input overlays the display. Transparent but
                interactive so the user's tap opens the native picker via a
                real user gesture. */}
            <input
              ref={nativeDateRef}
              id={inputId}
              type="date"
              aria-label={label}
              value={isoValue}
              onChange={(e) => {
                handleNativeDateChange(e);
                externalOnChange?.(e);
              }}
              onBlur={externalOnBlur}
              onKeyDown={handleKeyDown}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            {/* Hidden input bound to react-hook-form for value/ref management */}
            <input
              ref={mergedRef}
              type="hidden"
              name={props.name}
              value={isoValue}
              readOnly
            />
          </div>
          {props.error && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{props.error}</p>
          )}
        </div>
      );
    }

    // Calendar icon + popover shared by both desktop modes
    const calendarButton = (
      <button
        type="button"
        tabIndex={-1}
        onClick={handleCalendarClick}
        aria-label="Open date picker"
        className="absolute top-px bottom-px right-px z-10 flex items-center pr-2.5 pl-1 bg-white dark:bg-gray-800 rounded-r-md text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      >
        {calendarIconSvg}
      </button>
    );

    // --- Desktop mode (both formatted and browser) ---
    // Native date input (supports arrow-key segment navigation) with the
    // browser's built-in picker icon hidden, replaced by CalendarPopover.
    if (mode === 'desktop-formatted' || mode === 'desktop-browser') {
      return (
        <div className="w-full">
          {labelBlock}
          <div className="relative" ref={calendarAnchorRef}>
            <Input
              ref={ref}
              id={inputId}
              type="date"
              value={externalValue}
              onChange={(e) => {
                externalOnChange?.(e);
                if (e.target.value) onDateChange?.(e.target.value);
              }}
              onBlur={externalOnBlur}
              onKeyDown={handleKeyDown}
              error={props.error}
              className="pr-9 date-picker-hide"
              {...props}
            />
            {calendarButton}
            {showCalendar && (
              <CalendarPopover
                value={(externalValue as string) || ''}
                onSelect={(date) => {
                  if (onDateChange) onDateChange(date);
                  externalOnChange?.({ target: { value: date } } as ChangeEvent<HTMLInputElement>);
                }}
                onClose={handleCalendarClose}
                anchorRef={calendarAnchorRef}
              />
            )}
          </div>
        </div>
      );
    }

    // --- Touch browser mode ---
    // Native date input using the browser's locale format with native picker.
    // The calendar icon is a visual overlay only -- pointer-events-none lets
    // taps fall through to the input, which opens the picker via user gesture.
    return (
      <div className="w-full">
        {labelBlock}
        <div className="relative">
          <Input
            ref={ref}
            id={inputId}
            type="date"
            value={externalValue}
            onChange={externalOnChange}
            onBlur={externalOnBlur}
            onKeyDown={handleKeyDown}
            className="pr-10"
            {...props}
          />
          <span
            aria-hidden="true"
            className="absolute inset-y-0 right-3 flex items-center text-gray-400 dark:text-gray-500 pointer-events-none"
          >
            {calendarIconSvg}
          </span>
        </div>
      </div>
    );
  }
);

DateInput.displayName = 'DateInput';
