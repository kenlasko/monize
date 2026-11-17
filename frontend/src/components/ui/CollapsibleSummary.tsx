'use client';

import { ReactNode, useId } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

interface CollapsibleSummaryProps {
  /** What the cards are, e.g. "Summary"; also the region's accessible name. */
  title: string;
  /** The toggle's label while folded, e.g. "Show summary". */
  showLabel: string;
  /** The toggle's label while open, e.g. "Hide summary". */
  hideLabel: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The summary cards. */
  children: ReactNode;
}

/**
 * A page's row of summary cards, behind a one-line fold so a phone can give
 * the space to the list under them. The caller owns the state and remembers
 * it (a `useLocalStorage` key per page); folded, only the toggle's line stays.
 */
export function CollapsibleSummary({
  title,
  showLabel,
  hideLabel,
  collapsed,
  onToggle,
  children,
}: CollapsibleSummaryProps) {
  const contentId = useId();
  return (
    <section aria-label={title} className="mb-4 sm:mb-6">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        className="flex w-full min-h-8 items-center justify-between gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
          {collapsed ? showLabel : hideLabel}
          <ChevronDownIcon
            aria-hidden="true"
            className={`h-4 w-4 transition-transform motion-reduce:transition-none ${collapsed ? '' : 'rotate-180'}`}
          />
        </span>
      </button>
      {/* Always in the tree, so the toggle's `aria-controls` names an element
          that exists while folded too. */}
      <div id={contentId} hidden={collapsed} className="mt-2">
        {!collapsed && children}
      </div>
    </section>
  );
}
