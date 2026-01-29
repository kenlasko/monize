'use client';

import { useMemo } from 'react';
import { ScheduledTransaction, FrequencyType } from '@/types/scheduled-transaction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { parseLocalDate } from '@/lib/utils';

interface OccurrenceDatePickerProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrideDates?: string[]; // Dates that already have overrides
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
  overrideDates = [],
  onSelect,
  onClose,
}: OccurrenceDatePickerProps) {
  const { formatDate } = useDateFormat();

  // Convert to Set for O(1) lookups
  const overrideDateSet = useMemo(() => new Set(overrideDates), [overrideDates]);

  const nextDates = useMemo(() => {
    return calculateNextDates(
      scheduledTransaction.nextDueDate,
      scheduledTransaction.frequency,
      5
    );
  }, [scheduledTransaction.nextDueDate, scheduledTransaction.frequency]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
        {/* Backdrop */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75 dark:bg-gray-900 dark:bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal */}
        <div className="inline-block w-full max-w-sm px-4 pt-5 pb-4 overflow-hidden text-left align-bottom transition-all transform bg-white dark:bg-gray-800 rounded-lg shadow-xl sm:my-8 sm:align-middle sm:p-6">
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
            {nextDates.map((date, index) => {
              const hasOverride = overrideDateSet.has(date);
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
                      {index === 0 && (
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
        </div>
      </div>
    </div>
  );
}
