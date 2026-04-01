import { forwardRef, InputHTMLAttributes, KeyboardEvent, useCallback } from 'react';
import { Input } from './Input';
import { getLocalDateString } from '@/lib/utils';

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

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  ({ onDateChange, onKeyDown, ...props }, ref) => {

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
      const currentValue = e.currentTarget.value;
      let newDate: Date | null = null;

      switch (e.key) {
        case 't':
        case 'T':
          newDate = new Date();
          break;
        case 'y':
        case 'Y': {
          const d = parseOrToday(currentValue);
          newDate = new Date(d.getFullYear(), 0, 1);
          break;
        }
        case 'r':
        case 'R': {
          const d = parseOrToday(currentValue);
          newDate = new Date(d.getFullYear(), 11, 31);
          break;
        }
        case 'm':
        case 'M': {
          const d = parseOrToday(currentValue);
          newDate = new Date(d.getFullYear(), d.getMonth(), 1);
          break;
        }
        case 'h':
        case 'H': {
          const d = parseOrToday(currentValue);
          // Day 0 of next month = last day of current month
          newDate = new Date(d.getFullYear(), d.getMonth() + 1, 0);
          break;
        }
        case '+':
        case '=': {
          const d = parseOrToday(currentValue);
          if (!currentValue) {
            // If blank, put tomorrow
            d.setDate(d.getDate() + 1);
          } else {
            d.setDate(d.getDate() + 1);
          }
          newDate = d;
          break;
        }
        case '-': {
          const d = parseOrToday(currentValue);
          d.setDate(d.getDate() - 1);
          newDate = d;
          break;
        }
        case 'PageUp': {
          e.preventDefault();
          const d = parseOrToday(currentValue);
          newDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
          break;
        }
        case 'PageDown': {
          e.preventDefault();
          const d = parseOrToday(currentValue);
          newDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
          break;
        }
        default:
          break;
      }

      if (newDate) {
        e.preventDefault();
        const dateStr = getLocalDateString(newDate);
        onDateChange?.(dateStr);
      }

      onKeyDown?.(e);
    }, [onDateChange, onKeyDown]);

    return (
      <Input
        ref={ref}
        type="date"
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  }
);

DateInput.displayName = 'DateInput';
