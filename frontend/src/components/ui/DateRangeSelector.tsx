'use client';

import { cn } from '@/lib/utils';

interface DateRangeSelectorProps {
  /** Ordered list of preset range keys to display as buttons. */
  ranges: readonly string[];
  /** Currently selected range. */
  value: string;
  /** Called when a range button is clicked. */
  onChange: (range: string) => void;
  /** Whether to show a "Custom" button with date inputs. Default: false. */
  showCustom?: boolean;
  /** Custom start date (YYYY-MM-DD). Required when showCustom is true. */
  customStartDate?: string;
  /** Called when custom start date changes. */
  onCustomStartDateChange?: (date: string) => void;
  /** Custom end date (YYYY-MM-DD). Required when showCustom is true. */
  customEndDate?: string;
  /** Called when custom end date changes. */
  onCustomEndDateChange?: (date: string) => void;
  /** Active button colour class. Default: 'bg-blue-600'. */
  activeColour?: string;
  /** Button size variant. Default: 'md'. */
  size?: 'sm' | 'md';
  /** Additional className for the root container. */
  className?: string;
}

const formatLabel = (range: string): string => {
  if (range === 'ytd') return 'YTD';
  if (range === 'all') return 'All Time';
  return range.toUpperCase();
};

export function DateRangeSelector({
  ranges,
  value,
  onChange,
  showCustom = false,
  customStartDate = '',
  onCustomStartDateChange,
  customEndDate = '',
  onCustomEndDateChange,
  activeColour = 'bg-blue-600',
  size = 'md',
  className,
}: DateRangeSelectorProps) {
  const sizeClasses = size === 'sm'
    ? 'px-3 py-1 text-xs'
    : 'px-3 py-1.5 text-sm';

  const inactiveClasses = 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600';

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {ranges.map((range) => (
          <button
            key={range}
            onClick={() => onChange(range)}
            className={cn(
              sizeClasses,
              'font-medium rounded-md transition-colors',
              value === range
                ? `${activeColour} text-white`
                : inactiveClasses
            )}
          >
            {formatLabel(range)}
          </button>
        ))}
        {showCustom && (
          <button
            onClick={() => onChange('custom')}
            className={cn(
              sizeClasses,
              'font-medium rounded-md transition-colors',
              value === 'custom'
                ? `${activeColour} text-white`
                : inactiveClasses
            )}
          >
            Custom
          </button>
        )}
      </div>
      {showCustom && value === 'custom' && (
        <div className="flex gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => onCustomStartDateChange?.(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              End Date
            </label>
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => onCustomEndDateChange?.(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
        </div>
      )}
    </div>
  );
}
