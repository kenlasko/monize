'use client';

import { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { HelpLink } from '@/components/help/HelpLink';
import type { DocsLink } from '@/lib/docs-links';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Grey glyph above the title; sized h-12 w-12 by the component. */
  icon?: ReactNode;
  /** Already-translated one-line answer to "why is this list empty?". */
  title: string;
  /** Optional second line (what to do about it). */
  description?: ReactNode;
  /** Optional call to action (a Button, a link). */
  action?: ReactNode;
  /**
   * Where the guide explains this empty screen, a key of `DOCS_LINKS`. Renders
   * a quiet "How this works" link under the description; `action` renders too
   * when both are given.
   */
  help?: DocsLink;
  className?: string;
}

/**
 * The one empty-state layout for a list or panel with nothing to show:
 * centered grey glyph, one-line title, optional description and action.
 * This was the same `text-center py-12` block hand-rolled in fourteen
 * files, each drifting on its own; `ui-conventions.test.ts` keeps the
 * inline copies shrink-only.
 */
export function EmptyState({ icon, title, description, action, help, className }: EmptyStateProps) {
  const t = useTranslations('help');

  return (
    <div className={cn('text-center py-12', className)}>
      {icon && (
        <div
          aria-hidden
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 [&>svg]:h-12 [&>svg]:w-12"
        >
          {icon}
        </div>
      )}
      <h3
        className={cn(
          'text-sm font-medium text-gray-900 dark:text-gray-100',
          icon && 'mt-2',
        )}
      >
        {title}
      </h3>
      {description && (
        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</div>
      )}
      {help && (
        <div className="mt-2">
          <HelpLink link={help} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
            {t('howThisWorks')}
          </HelpLink>
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
