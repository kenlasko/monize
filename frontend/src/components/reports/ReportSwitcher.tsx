'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  EntitySwitcher,
  type EntitySwitcherItem,
} from '@/components/ui/EntitySwitcher';
import { REPORT_CATEGORIES } from '@/components/reports/report-definitions';
import { useReportCatalog } from '@/components/reports/useReportCatalog';

interface ReportSwitcherProps {
  /** The report on screen; the menu opens on it, highlighted. */
  currentId: string;
}

/**
 * The caret beside a report's title that jumps straight to another report,
 * without going back to the list and picking again -- the same control the
 * account, payee, category and security detail pages carry.
 *
 * Fifty-odd reports are too many to read as one column, so the menu is grouped
 * by the section the Reports page files each under, in the same order its
 * filter chips use. The reports the user has starred are lifted into a
 * "Favourites" section above those, so the ones they open most are the first
 * thing the caret shows -- and because favourite status is read live (built-ins
 * from the reactive preference, saved reports from their own flag), toggling a
 * star reorders the menu without a reload. A favourite is shown once, at the
 * top; its category section keeps only the remaining reports.
 *
 * The report on screen is listed too, highlighted, and the menu opens scrolled
 * to it: on Investment Performance the other Investment reports are what the
 * reader is most likely after, and they sit right beside it. For that reason
 * the current report is always filed under its own category, even when it is
 * starred -- shown in Favourites it would open the menu at the top, away from
 * its siblings.
 *
 * Picking a report navigates, and the route is built here rather than by each
 * caller: an id in this menu *is* a path under `/reports/`, and two call sites
 * spelling that out separately is one of them getting it wrong later.
 */
export function ReportSwitcher({ currentId }: ReportSwitcherProps) {
  const t = useTranslations('reports');
  const router = useRouter();
  const { reports } = useReportCatalog();

  const items = useMemo<EntitySwitcherItem[]>(() => {
    const label = (category: string) =>
      t(`page.categories.${category}` as Parameters<typeof t>[0]);
    const favouritesLabel = t('detailHeader.favourites');
    const toItem = (
      report: (typeof reports)[number],
      group: string,
    ): EntitySwitcherItem => ({
      id: report.id,
      primary: report.name,
      // The section is the heading above the row, so repeating it beside the
      // name would say the same thing twice. A favourite is searchable by its
      // own category too, so typing "spending" still finds a starred spending
      // report sitting in the Favourites section.
      group,
      searchText: `${report.name} ${label(report.category)}`,
    });
    // Ordered section by section: `EntitySwitcher` takes the order of the
    // sections from the order their first item appears in, so the Favourites
    // rows come first by being emitted first -- each in REPORT_CATEGORIES order
    // so the top section reads in the same order as the rest of the menu.
    const favourites = REPORT_CATEGORIES.flatMap((category) =>
      reports
        .filter(
          (report) =>
            report.category === category &&
            report.isFavourite &&
            report.id !== currentId,
        )
        .map((report) => toItem(report, favouritesLabel)),
    );
    // The remaining (non-favourite) reports, plus the current one, filed under
    // their own section.
    const rest = REPORT_CATEGORIES.flatMap((category) =>
      reports
        .filter(
          (report) =>
            report.category === category &&
            (!report.isFavourite || report.id === currentId),
        )
        .map((report) => toItem(report, label(category))),
    );
    return [...favourites, ...rest];
  }, [reports, t, currentId]);

  return (
    <EntitySwitcher
      currentId={currentId}
      showCurrent
      items={items}
      onSelect={(id) => router.push(`/reports/${id}`)}
      triggerLabel={t('detailHeader.switchReport')}
      filterPlaceholder={t('detailHeader.switchPlaceholder')}
      noMatchesLabel={t('detailHeader.switchNoMatches')}
    />
  );
}
