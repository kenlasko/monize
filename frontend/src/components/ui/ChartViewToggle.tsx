'use client';

import { cn } from '@/lib/utils';

type ChartView = 'pie' | 'bar';

interface ChartViewToggleProps {
  value: ChartView;
  onChange: (view: ChartView) => void;
  activeColour?: string;
  className?: string;
}

export function ChartViewToggle({
  value,
  onChange,
  activeColour = 'bg-blue-600',
  className,
}: ChartViewToggleProps) {
  const inactiveClasses = 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';

  return (
    <div className={cn('flex gap-2', className)}>
      <button
        onClick={() => onChange('pie')}
        className={cn(
          'p-2 rounded-md transition-colors',
          value === 'pie' ? `${activeColour} text-white` : inactiveClasses
        )}
        title="Pie Chart"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
        </svg>
      </button>
      <button
        onClick={() => onChange('bar')}
        className={cn(
          'p-2 rounded-md transition-colors',
          value === 'bar' ? `${activeColour} text-white` : inactiveClasses
        )}
        title="Bar Chart"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      </button>
    </div>
  );
}
