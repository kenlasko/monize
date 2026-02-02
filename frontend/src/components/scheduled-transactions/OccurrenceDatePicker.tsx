'use client';

import { useMemo } from 'react';
import { ScheduledTransaction, FrequencyType } from '@/types/scheduled-transaction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { parseLocalDate } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';

interface Override {
  originalDate: string;
  overrideDate: string;
}

interface OccurrenceDatePickerProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrides?: Override[]; // Full override objects with originalDate and overrideDate
  onSelect: (date: string) => void;
  onClose: () => void;
}

function calculateNextDates(startDate: string, frequency: FrequencyType, count: number): string[] {
  const dates: string[] = [];
  let currentDate = parseLocalDate(startDate);

  for (let i = 0; i < count; i++) {
    // Format as YYYY-MM-DD
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);

    // Calculate next date based on frequency
    switch (frequency) {
      case 'DAILY':
        currentDate.setDate(currentDate.getDate() + 1);
        break;
      case 'WEEKLY':
        currentDate.setDate(currentDate.getDate() + 7);
        break;
      case 'BIWEEKLY':
        currentDate.setDate(currentDate.getDate() + 14);
        break;
      case 'SEMIMONTHLY':
        // Twice a month: 15th and last day of month
        if (currentDate.getDate() <= 15) {
          // Go to end of current month
          currentDate.setMonth(currentDate.getMonth() + 1, 0); // Day 0 of next month = last day of current month
        } else {
          // Go to 15th of next month
          currentDate.setMonth(currentDate.getMonth() + 1, 15);
        }
        break;
      case 'MONTHLY':
        currentDate.setMonth(currentDate.getMonth() + 1);
        break;
      case 'QUARTERLY':
        currentDate.setMonth(currentDate.getMonth() + 3);
        break;
      case 'YEARLY':
        currentDate.setFullYear(currentDate.getFullYear() + 1);
        break;
      case 'ONCE':
      default:
        // For one-time, just return the single date
        return dates;
    }
  }

  return dates;
}

export function OccurrenceDatePicker({
  isOpen,
  scheduledTransaction,
  overrides = [],
  onSelect,
  onClose,
}: OccurrenceDatePickerProps) {
  const { formatDate } = useDateFormat();

  // Create maps for O(1) lookups
  // originalDateToOverrideDate: maps original calculated dates to their override dates
  // overrideDateSet: set of all override dates (to mark them as "modified")
  const { originalDateToOverrideDate, overrideDateSet } = useMemo(() => {
    const dateMap = new Map<string, string>();
    const dateSet = new Set<string>();
    for (const override of overrides) {
      dateMap.set(override.originalDate, override.overrideDate);
      dateSet.add(override.overrideDate);
    }
    return { originalDateToOverrideDate: dateMap, overrideDateSet: dateSet };
  }, [overrides]);

  // Calculate next dates based on frequency
  const calculatedDates = useMemo(() => {
    return calculateNextDates(
      scheduledTransaction.nextDueDate,
      scheduledTransaction.frequency,
      5
    );
  }, [scheduledTransaction.nextDueDate, scheduledTransaction.frequency]);

  // Build the final list of dates to display:
  // - For each calculated date, if it has an override, show the override date instead
  // - This ensures we don't show BOTH the original and override dates
  const nextDates = useMemo(() => {
    const resultDates: string[] = [];
    const addedDates = new Set<string>();

    for (const calculatedDate of calculatedDates) {
      const overrideDate = originalDateToOverrideDate.get(calculatedDate);
      const dateToShow = overrideDate || calculatedDate;

      // Avoid duplicates (in case an override date matches another calculated date)
      if (!addedDates.has(dateToShow)) {
        resultDates.push(dateToShow);
        addedDates.add(dateToShow);
      }
    }

    // Also add any override dates that aren't already included
    // (for overrides of dates outside the calculated window)
    for (const override of overrides) {
      if (!addedDates.has(override.overrideDate)) {
        resultDates.push(override.overrideDate);
        addedDates.add(override.overrideDate);
      }
    }

    return resultDates.sort();
  }, [calculatedDates, originalDateToOverrideDate, overrides]);

  // Track which date is the next due date
  const nextDueDate = scheduledTransaction.nextDueDate.split('T')[0];

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Select Occurrence Date
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Choose which occurrence of "{scheduledTransaction.name}" to modify:
      </p>

      <div className="space-y-2">
        {nextDates.map((date) => {
          const hasOverride = overrideDateSet.has(date);
          const isNextDue = date === nextDueDate;
          return (
            <button
              key={date}
              onClick={() => onSelect(date)}
              className={`w-full px-4 py-3 text-left rounded-lg border transition-colors ${
                hasOverride
                  ? 'border-purple-300 dark:border-purple-600 bg-purple-50 dark:bg-purple-900/20'
                  : 'border-gray-200 dark:border-gray-700'
              } hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-purple-300 dark:hover:border-purple-600`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {formatDate(date)}
                </span>
                <div className="flex items-center space-x-2">
                  {hasOverride && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                      Modified
                    </span>
                  )}
                  {isNextDue && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                      Next Due
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button
          onClick={onClose}
          className="w-full px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
