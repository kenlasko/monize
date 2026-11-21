'use client';

import { useContext, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { BackToReportsLink } from '@/components/reports/BackToReportsLink';
import { useReportSwitcher } from '@/components/reports/ReportSwitcher';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import {
  CollapsingTitleContext,
  useCollapsingHeaderTitle,
} from '@/hooks/useCollapsingHeaderTitle';

interface ReportDetailHeaderProps {
  /**
   * The report on screen, in the id form the Reports page uses -- which is also
   * its route: `tax-summary`, `custom/<uuid>`, `investment/<uuid>`.
   */
  reportId: string;
  title: string;
  subtitle?: string;
  /** Actions on this report (edit, export); the way back is not one of them. */
  actions?: ReactNode;
}

/**
 * The identity block for a single report: the way back to the list above the
 * title, and a caret beside it that jumps to another report. Built-in reports,
 * custom reports and investment reports all render this, so the three read as
 * one section rather than three pages that happen to share a URL prefix.
 */
export function ReportDetailHeader({
  reportId,
  title,
  subtitle,
  actions,
}: ReportDetailHeaderProps) {
  const t = useTranslations('reports');
  const switcher = useReportSwitcher(reportId);
  // Below `xl`, once the title scrolls behind the app header, the header reads
  // "Reports - <this report>" and carries the same caret.
  const collapses = useContext(CollapsingTitleContext);
  const titleRef = useCollapsingHeaderTitle<HTMLHeadingElement>(
    collapses ? { title: t('page.title'), context: title, switcher } : null,
  );

  return (
    <div className="ui-detail-header mb-6">
      <BackToReportsLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            {/* A long report title wraps on a phone (`break-words`, no clamp)
                rather than being cut with an ellipsis; the desktop keeps the
                single-line truncation (`sm:truncate`). The caret stays beside
                it -- the mobile-table identity treatment. */}
            <h1 ref={titleRef} className="ui-detail-title break-words text-2xl font-bold text-gray-900 sm:truncate dark:text-gray-100">
              {title}
            </h1>
            <EntitySwitcher {...switcher} />
          </div>
          {subtitle && (
            <p className="ui-detail-meta text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>

        {actions && (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        )}
      </div>
    </div>
  );
}
