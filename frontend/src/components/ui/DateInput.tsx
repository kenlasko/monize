import { ChangeEvent, forwardRef, InputHTMLAttributes, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { Input } from './Input';
import { CalendarPopover } from './CalendarPopover';
import { placePopover } from './InfoTooltip';
import { cn, getLocalDateString, formatDate, parseDateFromFormat, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import {
  TYPEABLE_DATE_SEPARATORS,
  datePatternLiteralChars,
  parseFlexibleDate,
} from '@/lib/date-parse';
import { useDateFormat } from '@/hooks/useDateFormat';
import { isTouchDevice } from '@/lib/touch-device';

interface DateInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  onDateChange?: (date: string) => void;
}

/**
 * Room for a date typed the long way round -- "September 14, 2026" is 18
 * characters, and the pattern's own length (10) would cut it off mid-word.
 * A bound is still worth having so a paste of a paragraph does not land in a
 * date field, but it is no longer the pattern's.
 */
const MAX_TYPED_DATE_LENGTH = 24;

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
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const showTooltip = useCallback(() => setOpen(true), []);
  const hideTooltip = useCallback(() => setOpen(false), []);

  // Measured before paint: left-aligned to the icon, clamped inside the
  // viewport and flipped above when it does not fit below (placePopover).
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = iconRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;
    const { top, left } = placePopover(
      anchor.getBoundingClientRect(),
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      'bottom',
      { width: window.innerWidth, height: window.innerHeight },
    );
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }, [open]);

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
      {open && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          className="fixed px-3 py-2 text-xs font-normal text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-[100] pointer-events-none"
          style={{ top: 0, left: 0, maxWidth: 'calc(100vw - 16px)' }}
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
            <span className="block mt-2 pt-2 border-t border-gray-200 dark:border-gray-600">
              {t('dateInput.partialDateHint')}
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

// Checks if a string looks like a YYYY-MM-DD date
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Parse a date pattern (e.g. "DD/MM/YYYY") into the segments it contains
// together with the character range each segment occupies in a formatted date.
// Used so the text input can map the cursor position back to a day/month/year
// segment and adjust it with ArrowUp/ArrowDown.
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

/**
 * Keep only characters that could belong to a typed date: letters (a month
 * name), digits, any separator a person might reach for, and whatever literal
 * the active pattern uses.
 *
 * Deliberately wider than the pattern itself. A user typing `9-14` into
 * `MM/DD/YYYY` means the fourteenth of September, and stripping the `-`
 * because the pattern spells its separator `/` turns that into `914`. The
 * parser decides what the text means; this only keeps out what is not a date
 * at all.
 */
function stripUntypeableChars(text: string, pattern: string): string {
  const literals = datePatternLiteralChars(pattern);
  let result = '';
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) result += ch;
    else if (TYPEABLE_DATE_SEPARATORS.has(ch)) result += ch;
    else if (literals.has(ch)) result += ch;
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


const calendarIconSvg = (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
  </svg>
);

/**
 * Two input modes, and the split is the pointer, never the format.
 *
 * `browser` used to select a native `<input type="date">` on the desktop, which
 * is why one date field in the app behaved unlike the next: the native control
 * jumps between its own segments after two keystrokes, takes only the first two
 * digits of a year typed into a partly-filled field, and cannot be handed
 * `9-14` at all. Every desktop field is now the same text box reading the same
 * pattern (issue #1201), with `browser` resolved to a real pattern upstream.
 *
 * Touch keeps the native picker, because a phone's date wheel is a better
 * control than a text box and nobody types a date on one by choice.
 */
type InputMode = 'desktop' | 'touch';

function getInputMode(): InputMode {
  return isTouchDevice() ? 'touch' : 'desktop';
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ onDateChange, onKeyDown, onChange: externalOnChange, onBlur: externalOnBlur, value: externalValue, label, id, name, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
    const t = useTranslations('common');
    const { datePattern } = useDateFormat();
    const mode = getInputMode();

    // Internal YYYY-MM-DD value; the display string is the same date rendered
    // through the user's pattern.
    const [isoValue, setIsoValue] = useState<string>((externalValue as string) || '');
    const [displayValue, setDisplayValue] = useState(() => {
      const val = (externalValue as string) || '';
      return val ? formatDate(val, datePattern) : '';
    });
    const isFocusedRef = useRef(false);
    const localRef = useRef<HTMLInputElement>(null);
    // Hidden native date input ref for touch mode
    const nativeDateRef = useRef<HTMLInputElement>(null);
    // Visible text input ref for desktop mode
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

    // On mount, read the initial value from the DOM. react-hook-form sets
    // defaultValues through the ref after mount, so we use a microtask to let
    // it complete before reading.
    useEffect(() => {
      // If we already have a value from props, nothing to do
      if (externalValue) return;

      const readDomValue = () => {
        const node = localRef.current;
        if (!node) return;
        const domVal = node.value;
        if (domVal && isIsoDate(domVal)) {
          setIsoValue(domVal);
          setDisplayValue(formatDate(domVal, datePattern));
        }
      };

      // Try immediately (react-hook-form may have set value synchronously in ref)
      readDomValue();

      // Also try after a microtask (react-hook-form may set value in an effect)
      const timer = setTimeout(readDomValue, 0);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, datePattern]);

    // Sync explicit value prop changes to internal state. When the caller is
    // uncontrolled (RHF register, no value prop), externalValue is undefined
    // and we skip -- the mount effect above reads the ref-injected DOM value
    // instead.
    useEffect(() => {
      if (externalValue === undefined) return;
      const newIso = (externalValue as string) || '';
      setIsoValue(newIso);
      if (!isFocusedRef.current) {
        setDisplayValue(newIso ? formatDate(newIso, datePattern) : '');
      }
    }, [externalValue, datePattern]);

    // Emit a YYYY-MM-DD value change through all relevant callbacks
    const emitDateChange = useCallback((dateStr: string) => {
      setIsoValue(dateStr);
      setDisplayValue(formatDate(dateStr, datePattern));
      if (onDateChange) {
        onDateChange(dateStr);
      }
    }, [onDateChange, datePattern]);

    /**
     * Read the text on screen as a date: the canonical form first, then the
     * lenient reading of what a person actually typed.
     *
     * A partial entry is completed from the value the field already holds, so
     * `14` in a field showing September stays in September, and only falls back
     * to today when the field is empty.
     */
    const parseTypedValue = useCallback((text: string): string | null => {
      const strict = parseDateFromFormat(text, datePattern);
      if (strict) return strict;
      return parseFlexibleDate(text, datePattern, parseOrToday(isoValue));
    }, [datePattern, isoValue]);

    // Commit whatever is typed, then show it in canonical form. Returns true
    // when the text named a date.
    const commitTypedValue = useCallback((): boolean => {
      const parsed = parseTypedValue(displayValue);
      if (parsed) {
        // A field that hands back its own value has not been edited. Blur runs
        // on every tab-through, and `onDateChange` is not always just a setter
        // -- the transactions filter switches its time period to Custom from
        // it, and the transfer form re-resolves an exchange rate -- so a
        // re-emit of the value already held is a change the user did not make.
        // The display is still canonicalized: that part is presentation.
        if (parsed === isoValue) {
          setDisplayValue(formatDate(parsed, datePattern));
        } else {
          emitDateChange(parsed);
        }
        return true;
      }
      // Unreadable text is not a request to clear the field: put back what the
      // field holds. An empty box is the only way to mean "no date".
      if (!displayValue.trim() && isoValue) {
        setIsoValue('');
        onDateChange?.('');
      } else if (isoValue) {
        setDisplayValue(formatDate(isoValue, datePattern));
      }
      return false;
    }, [parseTypedValue, displayValue, emitDateChange, isoValue, datePattern, onDateChange]);

    // Keyboard shortcut handler (works in both modes)
    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
      // Segment navigation: ArrowUp/ArrowDown increments the day/month/year
      // segment that the cursor is currently in, restoring the segment
      // highlight after the re-render so repeated arrow presses keep stepping
      // the same segment.
      if (
        mode === 'desktop'
        && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        && isoValue
      ) {
        const cursor = e.currentTarget.selectionStart ?? 0;
        const segment = findSegmentAtCursor(datePattern, cursor);
        if (segment) {
          e.preventDefault();
          const delta = e.key === 'ArrowUp' ? 1 : -1;
          emitDateChange(adjustIsoDate(isoValue, segment.type, delta));
          pendingSelectionRef.current = [segment.start, segment.end];
          onKeyDown?.(e);
          return;
        }
      }

      const isCompleteDate = !!isoValue && displayValue === formatDate(isoValue, datePattern);

      // Enter finishes the entry the way blurring does, so a partial date is
      // the date the form submits rather than the text left over from typing
      // it. Not prevented: the form's own Enter handling still runs, and by
      // then the parsed value has already gone out through onDateChange.
      if (mode === 'desktop' && e.key === 'Enter' && !isCompleteDate) {
        commitTypedValue();
        onKeyDown?.(e);
        return;
      }

      // While a date is being typed, a character that could be part of one is
      // text, not a shortcut: `-` in `9-14`, `.` in `14.9`, a letter in `Sep`.
      // Once a full canonical date is shown there is nothing left to type, so
      // those keys resume their shortcut role (`-` steps the day back).
      const couldBeTypedDateChar =
        TYPEABLE_DATE_SEPARATORS.has(e.key)
        || datePatternLiteralChars(datePattern).has(e.key)
        || (e.key.length === 1 && /\p{L}/u.test(e.key));
      if (mode === 'desktop' && !isCompleteDate && displayValue && couldBeTypedDateChar) {
        onKeyDown?.(e);
        return;
      }

      const currentIso = mode === 'desktop' ? isoValue : e.currentTarget.value;
      const newDate = resolveShortcutDate(e.key, currentIso);

      if (newDate) {
        e.preventDefault();
        emitDateChange(getLocalDateString(newDate));
      }

      onKeyDown?.(e);
    }, [mode, isoValue, displayValue, datePattern, emitDateChange, commitTypedValue, onKeyDown]);

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

    // Desktop: handle user typing in the formatted input. Strip anything that
    // could not be part of a date, so a stray character cannot land in the box.
    //
    // Deliberately does NOT reformat displayValue when parsing succeeds --
    // otherwise an unpadded intermediate like "12/3/2026" would be rewritten
    // to "12/03/2026" in the middle of a "12/03/2026" -> "12/23/2026" edit
    // and the user's next keystroke would land in the wrong place. The blur
    // handler applies the canonical format once editing is done.
    //
    // Only a *complete* date is reported while typing. The lenient reading of a
    // partial entry waits for blur or Enter: `9` is a valid day on its own, and
    // announcing the ninth of the month the moment it is typed would send the
    // parent -- a report reloading on every date change -- off after a date
    // nobody asked for.
    const handleTextChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      const text = stripUntypeableChars(e.target.value, datePattern);
      setDisplayValue(text);

      const parsed = parseDateFromFormat(text, datePattern);
      if (parsed) {
        setIsoValue(parsed);
        onDateChange?.(parsed);
      } else if (!text) {
        setIsoValue('');
        onDateChange?.('');
      }
    }, [datePattern, onDateChange]);

    // Desktop: complete and reformat on blur
    const handleTextBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
      isFocusedRef.current = false;
      commitTypedValue();
      externalOnBlur?.(e);
    }, [commitTypedValue, externalOnBlur]);

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

    // --- Touch mode ---
    // The user sees the date in their preferred format, but the actual
    // interactive element is a transparent native date input layered on top.
    // Letting the user tap directly into the native input is the only reliable
    // way to open the picker on iPad WebKit -- programmatic showPicker() on a
    // hidden input fails silently there.
    if (mode === 'touch') {
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
              {displayValue || datePattern}
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

    // --- Desktop mode ---
    // Visible text input displays the date in the user's pattern
    // (e.g. DD/MM/YYYY). A hidden input holds the canonical YYYY-MM-DD value
    // and is bound to react-hook-form via the forwarded ref.
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
            placeholder={datePattern}
            maxLength={MAX_TYPED_DATE_LENGTH}
            className="pr-9"
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={handleCalendarClick}
            aria-label={t('dateInput.openPicker')}
            className="absolute top-px bottom-px right-px z-10 flex items-center pr-2.5 pl-1 bg-white dark:bg-gray-800 rounded-r-md text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            {calendarIconSvg}
          </button>
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
);

DateInput.displayName = 'DateInput';
