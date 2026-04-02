'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface CalendarPopoverProps {
  /** Currently selected date in YYYY-MM-DD format */
  value: string;
  /** Called when a date is picked */
  onSelect: (date: string) => void;
  /** Called when the popover should close */
  onClose: () => void;
  /** Anchor element to position relative to */
  anchorRef: React.RefObject<HTMLElement | null>;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

type View = 'days' | 'months';

export function CalendarPopover({ value, onSelect, onClose, anchorRef }: CalendarPopoverProps) {
  const parsed = value ? value.split('-').map(Number) : null;
  const initialYear = parsed ? parsed[0] : new Date().getFullYear();
  const initialMonth = parsed ? parsed[1] - 1 : new Date().getMonth();

  const [viewYear, setViewYear] = useState(initialYear);
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const [view, setView] = useState<View>('days');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Position relative to anchor element
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 280;
    let left = rect.left;
    // Keep within viewport
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8;
    }
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + 4, left });
  }, [anchorRef]);

  // Close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  const prevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 0) { setViewYear((y) => y - 1); return 11; }
      return m - 1;
    });
  }, []);

  const nextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 11) { setViewYear((y) => y + 1); return 0; }
      return m + 1;
    });
  }, []);

  const handleDayClick = useCallback((day: number) => {
    onSelect(toIso(viewYear, viewMonth, day));
    onClose();
  }, [viewYear, viewMonth, onSelect, onClose]);

  const handleMonthSelect = useCallback((month: number) => {
    setViewMonth(month);
    setView('days');
  }, []);

  const handleClear = useCallback(() => {
    onSelect('');
    onClose();
  }, [onSelect, onClose]);

  const handleToday = useCallback(() => {
    const now = new Date();
    onSelect(toIso(now.getFullYear(), now.getMonth(), now.getDate()));
    onClose();
  }, [onSelect, onClose]);

  if (!position) return null;

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);
  const selectedDay = parsed && parsed[0] === viewYear && parsed[1] - 1 === viewMonth ? parsed[2] : null;

  // Build day grid
  const prevMonthDays = getDaysInMonth(viewYear, viewMonth === 0 ? 11 : viewMonth - 1);
  const cells: { day: number; current: boolean }[] = [];
  // Previous month trailing days
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, current: false });
  }
  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, current: true });
  }
  // Next month leading days
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let d = 1; d <= remaining; d++) {
      cells.push({ day: d, current: false });
    }
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 w-[280px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-xl"
      style={{ top: position.top, left: position.left }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={view === 'days' ? prevMonth : () => setViewYear((y) => y - 1)}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setView(view === 'days' ? 'months' : 'days')}
          className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 px-2 py-1 rounded"
        >
          {view === 'days'
            ? `${MONTHS[viewMonth]} ${viewYear}`
            : String(viewYear)}
        </button>
        <button
          type="button"
          onClick={view === 'days' ? nextMonth : () => setViewYear((y) => y + 1)}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>

      {view === 'days' ? (
        /* Day grid */
        <div className="p-2">
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-xs font-medium text-gray-500 dark:text-gray-400 py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell, i) => {
              const isSelected = cell.current && cell.day === selectedDay;
              const isToday = cell.current
                && viewYear === new Date().getFullYear()
                && viewMonth === new Date().getMonth()
                && cell.day === new Date().getDate();
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!cell.current}
                  onClick={() => cell.current && handleDayClick(cell.day)}
                  className={cn(
                    'w-9 h-9 text-sm rounded-full flex items-center justify-center',
                    cell.current
                      ? 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-300 dark:text-gray-600 cursor-default',
                    isSelected && 'bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-500',
                    isToday && !isSelected && 'ring-1 ring-blue-500',
                  )}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        /* Month grid */
        <div className="p-3">
          <div className="grid grid-cols-3 gap-2">
            {MONTHS.map((m, i) => (
              <button
                key={m}
                type="button"
                onClick={() => handleMonthSelect(i)}
                className={cn(
                  'px-2 py-2 text-sm rounded-md text-center',
                  'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100',
                  i === viewMonth && viewYear === initialYear && 'bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-500',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleToday}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium"
        >
          Today
        </button>
      </div>
    </div>,
    document.body,
  );
}
