'use client';

import { cn } from '@/lib/utils';

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface WidgetSegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  className?: string;
}

/**
 * A small segmented button group for widget settings that are a mutually
 * exclusive text choice (e.g. region/exchange/country, overview/by day) rather
 * than a chart-type icon toggle.
 */
export function WidgetSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
}: WidgetSegmentedControlProps<T>) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            value === option.value
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
