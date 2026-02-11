import { ReactNode } from 'react';

interface PageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Action buttons to render on the right side */
  actions?: ReactNode;
}

/**
 * Inline page header with title, subtitle, and action buttons.
 * Renders directly in the content area without a separate background bar.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className={`${actions ? 'flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4' : ''} mb-6`}>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {title}
        </h1>
        {subtitle && (
          <p className="text-gray-500 dark:text-gray-400">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
