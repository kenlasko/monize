'use client';

import { ReactNode, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { docsUrl, helpTarget, type DocsLink } from '@/lib/docs-links';
import { onHelpLinkClick, useHelpPrefetch } from '@/lib/help-open';
import { useHelpStore } from '@/store/helpStore';

interface PageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Action buttons to render on the right side */
  actions?: ReactNode;
  /**
   * The guide's page for this feature, a key of `DOCS_LINKS`
   * (`@/lib/docs-links`). A click opens it in the help panel; a modified click
   * (new tab, copy link) goes to the same page on monize.net.
   */
  help?: DocsLink;
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
  /**
   * Optional element drawn on the title's line, after it (e.g. a status pill
   * on a detail page). Omitted by default.
   */
  titleAdornment?: ReactNode;
}

/**
 * Inline page header with title, subtitle, and action buttons.
 * Renders directly in the content area without a separate background bar.
 */
export function PageHeader({ title, subtitle, actions, help, compactMobileActions, icon, titleAdornment }: PageHeaderProps) {
  const t = useTranslations('layout');

  // Know whether the guide is bundled before the first click, so the click can
  // decide synchronously (see `onHelpLinkClick`).
  useHelpPrefetch(help !== undefined);

  // The search dialog's context: this screen's help page, while this header
  // is on screen. Cleared on unmount so leaving the page leaves no stale
  // context behind for the next screen to inherit.
  const contextSlug = help ? helpTarget(help).page : null;
  useEffect(() => {
    useHelpStore.getState().setContextPage(contextSlug);
    return () => {
      if (useHelpStore.getState().contextPage === contextSlug) {
        useHelpStore.getState().setContextPage(null);
      }
    };
  }, [contextSlug]);

  const layoutClasses = actions
    ? compactMobileActions
      ? 'flex flex-row justify-between items-start sm:items-center gap-4'
      : 'flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4'
    : '';

  const titleBlock = (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          {title}
        </h1>
        {titleAdornment}
        {help && (
            <span className="relative inline-flex items-center group/help">
              <a
                href={docsUrl(help)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => onHelpLinkClick(e, help)}
                className="text-gray-400 hover:text-blue-500 transition-colors"
                aria-label={t('pageHeader.helpAriaLabel')}
              >
                <QuestionMarkCircleIcon className="h-5 w-5" />
              </a>
              {/* Shown on hover and on keyboard focus at every width: help is
                  never hidden below a breakpoint. */}
              <span
                role="tooltip"
                className="pointer-events-none hidden group-hover/help:block group-focus-within/help:block absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1 w-56 whitespace-normal rounded-md bg-gray-900 dark:bg-gray-700 px-2.5 py-2 text-xs font-normal leading-snug text-white shadow-lg"
              >
                {t('pageHeader.helpTooltip')}
              </span>
            </span>
          )}
        </div>
      {subtitle && (
        <p className="mt-0.5 text-sm sm:text-base text-gray-500 dark:text-gray-400">
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
