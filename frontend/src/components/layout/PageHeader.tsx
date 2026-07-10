'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

interface PageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Action buttons to render on the right side */
  actions?: ReactNode;
  /** URL to the wiki help page for this feature */
  helpUrl?: string;
  /**
   * Keep the actions inline (on the same row as the title) on mobile instead
   * of stacking them full-width below it. Use for compact, icon-sized actions.
   */
  compactMobileActions?: boolean;
  /**
   * Optional leading element rendered to the left of the title (e.g. an
   * institution logo on account detail pages). Omitted by default.
   */
  icon?: ReactNode;
}

/**
 * Inline page header with title, subtitle, and action buttons.
 * Renders directly in the content area without a separate background bar.
 */
export function PageHeader({ title, subtitle, actions, helpUrl, compactMobileActions, icon }: PageHeaderProps) {
  const t = useTranslations('layout');

  const layoutClasses = actions
    ? compactMobileActions
      ? 'flex flex-row justify-between items-start sm:items-center gap-4'
      : 'flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4'
    : '';

  const titleBlock = (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {title}
        </h1>
        {helpUrl && (
            <span className="relative inline-flex items-center group/help">
              <a
                href={helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-blue-500 transition-colors"
                aria-label={t('pageHeader.helpAriaLabel')}
              >
                <QuestionMarkCircleIcon className="h-5 w-5" />
              </a>
              <span
                role="tooltip"
                className="pointer-events-none hidden md:group-hover/help:block absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1 w-56 whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg"
              >
                {t('pageHeader.helpTooltip')}
              </span>
            </span>
          )}
        </div>
      {subtitle && (
        <p className="text-gray-500 dark:text-gray-400">
          {subtitle}
        </p>
      )}
    </div>
  );

  return (
    <div className={`${layoutClasses} mb-6`}>
      {icon ? (
        <div className="flex items-center gap-3">
          {icon}
          {titleBlock}
        </div>
      ) : (
        titleBlock
      )}
      {actions && (
        <div
          className={`flex flex-wrap items-center gap-3 ${
            compactMobileActions
              ? 'w-auto'
              : 'w-full sm:w-auto [&>*]:w-full [&>*]:sm:w-auto'
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
