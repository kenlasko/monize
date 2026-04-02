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

// Checks if a string looks like a YYYY-MM-DD date
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

type InputMode = 'browser' | 'desktop-formatted' | 'touch-formatted';

function getInputMode(dateFormat: string): InputMode {
  if (dateFormat === 'browser') return 'browser';
  return isTouchDevice() ? 'touch-formatted' : 'desktop-formatted';
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ onDateChange, onKeyDown, onChange: externalOnChange, onBlur: externalOnBlur, value: externalValue, label, id, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
    const { dateFormat } = useDateFormat();
    const mode = getInputMode(dateFormat);

    // Internal YYYY-MM-DD value for formatted modes (desktop-formatted + touch-formatted)
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
      if (mode === 'browser') return;
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
      if (mode === 'browser') return;
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
      const currentIso = mode !== 'browser' ? isoValue : e.currentTarget.value;
      const newDate = resolveShortcutDate(e.key, currentIso);

      if (newDate) {
        e.preventDefault();
        const dateStr = getLocalDateString(newDate);

        if (mode !== 'browser') {
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
    const handleTextChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setDisplayValue(text);

      const parsed = parseDateFromFormat(text, dateFormat);
      if (parsed) {
        emitDateChange(parsed);
      }
    }, [dateFormat, emitDateChange]);

    // Desktop text mode: reformat on blur
    const handleTextBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
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

    const handleTextFocus = useCallback(() => {
      isFocusedRef.current = true;
    }, []);

    // Desktop: toggle custom calendar popover
    const [showCalendar, setShowCalendar] = useState(false);
    const calendarAnchorRef = useRef<HTMLDivElement>(null);

    const handleCalendarClick = useCallback(() => {
      setShowCalendar((prev) => !prev);
    }, []);

    const handleCalendarSelect = useCallback((date: string) => {
      if (date) {
        emitDateChange(date);
      }
    }, [emitDateChange]);

    const handleCalendarClose = useCallback(() => {
      setShowCalendar(false);
    }, []);

    // Touch mode: open the native date picker when the display is tapped
    const handleTouchTap = useCallback(() => {
      const picker = nativeDateRef.current;
      if (!picker) return;
      // Sync current value to native input before opening
      picker.value = isoValue;
      if (typeof picker.showPicker === 'function') {
        picker.showPicker();
      } else {
        // Fallback for older browsers: focus triggers the picker
        picker.focus();
        picker.click();
      }
    }, [isoValue]);

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
    // Shows the formatted date in a tappable display; tapping opens a hidden
    // native date picker so the user gets both their preferred format AND the
    // native calendar/wheel UI.
    if (mode === 'touch-formatted') {
      return (
        <div className="w-full">
          {labelBlock}
          <div className="relative">
            {/* Visible formatted display the user sees and taps */}
            <button
              type="button"
              id={inputId}
              onClick={handleTouchTap}
              className={cn(
                inputBaseClasses,
                'border px-3 py-2 focus:ring-1 focus:outline-none text-left',
                props.error && inputErrorClasses,
                !displayValue && 'text-gray-400 dark:text-gray-500',
              )}
            >
              {displayValue || dateFormat}
            </button>
            {/* Hidden native date input for the picker.
                Positioned to overlap the button so the popup anchors correctly. */}
            <input
              ref={nativeDateRef}
              type="date"
              tabIndex={-1}
              aria-hidden="true"
              className="absolute inset-0 opacity-0 pointer-events-none"
              onChange={handleNativeDateChange}
            />
            {/* Hidden input for react-hook-form ref/value management */}
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

    // --- Desktop + custom format mode ---
    // Text input that shows and accepts dates in the user's preferred format,
    // with a calendar icon to open a custom calendar popover.
    if (mode === 'desktop-formatted') {
      return (
        <div className="w-full">
          {labelBlock}
          <div className="relative" ref={calendarAnchorRef}>
            <Input
              ref={mergedRef}
              id={inputId}
              type="text"
              value={displayValue}
              onChange={handleTextChange}
              onBlur={handleTextBlur}
              onFocus={handleTextFocus}
              onKeyDown={handleKeyDown}
              placeholder={dateFormat}
              error={props.error}
              className="pr-9"
              {...props}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={handleCalendarClick}
              aria-label="Open date picker"
              className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
            </button>
            {showCalendar && (
              <CalendarPopover
                value={isoValue}
                onSelect={handleCalendarSelect}
                onClose={handleCalendarClose}
                anchorRef={calendarAnchorRef}
              />
            )}
          </div>
        </div>
      );
    }

    // --- Browser format mode ---
    // Native date input using the browser's locale format.
    return (
      <div className="w-full">
        {labelBlock}
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
