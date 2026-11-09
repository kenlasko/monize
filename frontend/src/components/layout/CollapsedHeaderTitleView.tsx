'use client';

import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import type { CollapsedHeaderTitle } from '@/store/mobileChromeStore';

/**
 * The page title (and the dashboard's headline figure) as it reads once it has
 * scrolled behind the header. Hidden from screen readers: the title and figure
 * it repeats are still in the page, and two copies would be read twice.
 */
export function CollapsedHeaderTitleView({ content }: { content: CollapsedHeaderTitle }) {
  const { title, figure, figurePartial, change } = content;
  const ChangeArrow = change?.up ? ArrowUpIcon : ArrowDownIcon;

  return (
    <div
      aria-hidden="true"
      data-testid="collapsed-header-title"
      className="min-w-0 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none xl:hidden"
    >
      {figure === undefined ? (
        <div className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </div>
      ) : (
        <>
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">{title}</div>
          <div className="flex items-baseline gap-1.5 text-base font-bold leading-tight text-gray-900 dark:text-gray-50">
            <span className="truncate">
              {figure}
              {figurePartial && <span className="text-amber-600 dark:text-amber-400">*</span>}
            </span>
            {change && (
              <span
                className={`inline-flex flex-shrink-0 items-center text-xs font-semibold ${
                  change.up
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                <ChangeArrow className="h-3 w-3" />
                {change.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
