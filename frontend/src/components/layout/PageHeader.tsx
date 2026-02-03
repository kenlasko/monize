import { ReactNode } from 'react';

interface PageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Action buttons to render on the right side */
  actions?: ReactNode;
  /** Whether to show bottom border instead of shadow (used in transactions page) */
  borderStyle?: 'shadow' | 'border';
  /** Custom padding class - defaults to standard padding */
  paddingClass?: string;
}

/**
 * Standard page header with title, subtitle, and action buttons.
 * Used consistently across all pages for the top section.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  borderStyle = 'shadow',
  paddingClass = 'px-4 sm:px-6 lg:px-12 py-6',
}: PageHeaderProps) {
  const borderClass = borderStyle === 'shadow'
    ? 'shadow dark:shadow-gray-700/50'
    : 'border-b border-gray-200 dark:border-gray-700';

  return (
    <div className={`bg-white dark:bg-gray-800 ${borderClass}`}>
      <div className={paddingClass}>
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {subtitle}
              </p>
            )}
          </div>
          {actions && <div className="flex items-center gap-3">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
