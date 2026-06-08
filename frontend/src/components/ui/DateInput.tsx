import { ChangeEvent, forwardRef, InputHTMLAttributes, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
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

function DateShortcutTooltip() {
  const t = useTranslations('common');
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
      <QuestionMarkCircleIcon
        className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 cursor-help"
        strokeWidth={2}
      />
      {position && createPortal(
        <div
          role="tooltip"
          className="fixed -translate-x-1/2 px-3 py-2 text-xs font-normal text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg whitespace-nowrap z-[100] pointer-events-none"
          style={{ top: position.top, left: position.left }}
        >
          <>
            <span className="block font-medium mb-1">{t('dateInput.shortcutsTitle')}</span>
            <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <kbd className="font-mono">T</kbd><span>{t('dateInput.today')}</span>
              <kbd className="font-mono">Y</kbd><span>{t('dateInput.firstDayOfYear')}</span>
              <kbd className="font-mono">R</kbd><span>{t('dateInput.lastDayOfYear')}</span>
              <kbd className="font-mono">M</kbd><span>{t('dateInput.firstDayOfMonth')}</span>
              <kbd className="font-mono">H</kbd><span>{t('dateInput.lastDayOfMonth')}</span>
              <kbd className="font-mono">+</kbd><span>{t('dateInput.nextDay')}</span>
              <kbd className="font-mono">-</kbd><span>{t('dateInput.previousDay')}</span>
              <kbd className="font-mono">PgUp</kbd><span>{t('dateInput.nextMonth')}</span>
              <kbd className="font-mono">PgDn</kbd><span>{t('dateInput.previousMonth')}</span>
            </span>
          </>
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

// Parse a date format string (e.g. "DD/MM/YYYY") into the segments it contains
// together with the character range each segment occupies in a formatted date.
// Used so desktop-formatted mode can map the cursor position back to a
// day/month/year segment and adjust it with ArrowUp/ArrowDown.
type DateSegmentType = 'day' | 'month' | 'year';
interface DateSegment {
  type: DateSegmentType;
  start: number;
  end: number;
}

function parseFormatSegments(format: string): DateSegment[] {
  const segments: DateSegment[] = [];
  let i = 0;
  while (i < format.length) {
    if (format.startsWith('YYYY', i)) {
      segments.push({ type: 'year', start: i, end: i + 4 });
      i += 4;
    } else if (format.startsWith('MMM', i)) {
      segments.push({ type: 'month', start: i, end: i + 3 });
      i += 3;
    } else if (format.startsWith('MM', i)) {
      segments.push({ type: 'month', start: i, end: i + 2 });
      i += 2;
    } else if (format.startsWith('DD', i)) {
      segments.push({ type: 'day', start: i, end: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
  }
  return segments;
}

function findSegmentAtCursor(format: string, cursor: number): DateSegment | null {
  const segments = parseFormatSegments(format);
  return segments.find(s => cursor >= s.start && cursor <= s.end) ?? null;
}

// Return only characters that can legally appear in a value formatted with
// `format` -- digits always, letters only when the format contains a month
// name segment (MMM), and any separator that literally appears in the format.
function stripInvalidFormatChars(text: string, format: string): string {
  const allowsLetters = format.includes('MMM');
  const separators = new Set<string>();
  for (const ch of format) {
    if (ch !== 'Y' && ch !== 'M' && ch !== 'D') separators.add(ch);
  }
  let result = '';
  for (const ch of text) {
    if (/\d/.test(ch)) result += ch;
    else if (allowsLetters && /[a-zA-Z]/.test(ch)) result += ch;
    else if (separators.has(ch)) result += ch;
  }
  return result;
}

// Adjust a YYYY-MM-DD date by delta on the given segment. Clamps day when the
// target month/year has fewer days (e.g. Jan 31 + month -> Feb 28/29).
function adjustIsoDate(iso: string, segmentType: DateSegmentType, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (segmentType === 'year') {
    const newYear = y + delta;
    const daysInMonth = new Date(newYear, m, 0).getDate();
    return `${String(newYear).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`;
  }
  if (segmentType === 'month') {
    let month = m + delta;
    let year = y;
    while (month > 12) { month -= 12; year += 1; }
    while (month < 1) { month += 12; year -= 1; }
    const daysInMonth = new Date(year, month, 0).getDate();
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`;
  }
  // Day: let the Date constructor handle rollover between months/years
  return getLocalDateString(new Date(y, m - 1, d + delta));
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
  ({ onDateChange, onKeyDown, onChange: externalOnChange, onBlur: externalOnBlur, value: externalValue, label, id, name, ...props }, ref) => {
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
    // Visible text input ref for desktop-formatted mode
    const textInputRef = useRef<HTMLInputElement>(null);
    // Segment range to re-select after emitDateChange re-renders the text input
    const pendingSelectionRef = useRef<[number, number] | null>(null);

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

    // Sync explicit value prop changes to internal state. When the caller is
    // uncontrolled (RHF register, no value prop), externalValue is undefined
    // and we skip -- the mount effect below reads the ref-injected DOM value
    // instead.
    useEffect(() => {
      if (mode === 'touch-browser') return;
      if (externalValue === undefined) return;
      const newIso = (externalValue as string) || '';
      setIsoValue(newIso);
      if (!isFocusedRef.current) {
        setDisplayValue(newIso ? formatDate(newIso, dateFormat) : '');
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
      // Desktop-formatted segment navigation: ArrowUp/ArrowDown increments the
      // day/month/year segment that the cursor is currently in, restoring the
      // segment highlight after the re-render so repeated arrow presses keep
      // stepping the same segment.
      if (
        mode === 'desktop-formatted'
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && isoValue
      ) {
        const cursor = e.currentTarget.selectionStart ?? 0;
        const segment = findSegmentAtCursor(dateFormat, cursor);
        if (segment) {
          e.preventDefault();
          const delta = e.key === 'ArrowUp' ? 1 : -1;
          emitDateChange(adjustIsoDate(isoValue, segment.type, delta));
          pendingSelectionRef.current = [segment.start, segment.end];
          onKeyDown?.(e);
          return;
        }
      }

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
    }, [mode, isoValue, dateFormat, emitDateChange, onDateChange, onKeyDown]);

    // Restore a segment highlight after the controlled text input re-renders
    // with a new displayValue.
    useEffect(() => {
      const range = pendingSelectionRef.current;
      if (!range) return;
      const input = textInputRef.current;
      if (!input) return;
      input.setSelectionRange(range[0], range[1]);
      pendingSelectionRef.current = null;
    }, [displayValue]);

    // Desktop text mode: handle user typing in the formatted input. Strip any
    // character that can't appear in the format so users can't enter letters
    // in MM/DD/YYYY or the like. maxLength on the input handles the
    // "too-long" case at the DOM level.
    //
    // Deliberately does NOT reformat displayValue when parsing succeeds --
    // otherwise an unpadded intermediate like "12/3/2026" would be rewritten
    // to "12/03/2026" in the middle of a "12/03/2026" -> "12/23/2026" edit
    // and the user's next keystroke would land in the wrong place. The blur
    // handler applies the canonical format once editing is done.
    const handleTextChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const text = stripInvalidFormatChars(e.target.value, dateFormat);
      setDisplayValue(text);

      const parsed = parseDateFromFormat(text, dateFormat);
      if (parsed) {
        setIsoValue(parsed);
        onDateChange?.(parsed);
      } else if (!text) {
        setIsoValue('');
        onDateChange?.('');
      }
    }, [dateFormat, onDateChange]);

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
              name={name}
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

    // --- Desktop + custom format mode ---
    // Visible text input displays the date in the user's chosen format
    // (e.g. DD/MM/YYYY). A hidden input holds the canonical YYYY-MM-DD value
    // and is bound to react-hook-form via the forwarded ref.
    if (mode === 'desktop-formatted') {
      return (
        <div className="w-full">
          {labelBlock}
          <div className="relative" ref={calendarAnchorRef}>
            <Input
              ref={textInputRef}
              id={inputId}
              type="text"
              value={displayValue}
              onChange={handleTextChange}
              onFocus={handleTextFocus}
              onBlur={handleTextBlur}
              onKeyDown={handleKeyDown}
              error={props.error}
              placeholder={dateFormat}
              maxLength={dateFormat.length}
              className="pr-9"
              {...props}
            />
            {calendarButton}
            {showCalendar && (
              <CalendarPopover
                value={isoValue}
                onSelect={handleCalendarSelect}
                onClose={handleCalendarClose}
                anchorRef={calendarAnchorRef}
              />
            )}
            {/* Hidden input bound to react-hook-form for value/ref management */}
            <input
              ref={mergedRef}
              type="hidden"
              name={name}
              value={isoValue}
              readOnly
            />
          </div>
        </div>
      );
    }

    // --- Desktop + browser-locale mode ---
    // Native date input (supports arrow-key segment navigation) with the
    // browser's built-in picker icon hidden, replaced by CalendarPopover.
    if (mode === 'desktop-browser') {
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
              name={name}
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
            name={name}
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
