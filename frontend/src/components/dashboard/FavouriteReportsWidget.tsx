'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { customReportsApi } from '@/lib/custom-reports';
import { investmentReportsApi } from '@/lib/investment-reports';
import { getIconComponent } from '@/components/ui/IconPicker';
import {
  ReportCategory,
  builtInReports,
  categoryColors,
} from '@/components/reports/report-definitions';
import { createLogger } from '@/lib/logger';

const logger = createLogger('FavouriteReportsWidget');

const fallbackReportIcon = (
  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

interface FavouriteReportsWidgetProps {
  isLoading: boolean;
}

interface FavouriteReportEntry {
  /** Route id: a built-in id, `custom/<uuid>` or `investment/<uuid>`. */
  id: string;
  /** Set for custom/investment reports; built-ins resolve names via i18n. */
  name?: string;
  category: ReportCategory;
  color: string;
  backgroundColor?: string | null;
  icon: React.ReactNode;
}

export function FavouriteReportsWidget({ isLoading: parentLoading }: FavouriteReportsWidgetProps) {
  const t = useTranslations('dashboard');
  const tReports = useTranslations('reports');
  const router = useRouter();
  const favouriteReportIds = usePreferencesStore((s) => s.preferences?.favouriteReportIds);
  const [managedFavourites, setManagedFavourites] = useState<FavouriteReportEntry[]>([]);
  const [isLoadingManaged, setIsLoadingManaged] = useState(true);

  useEffect(() => {
    if (parentLoading) return;

    const loadManagedFavourites = async () => {
      try {
        const [custom, investment] = await Promise.all([
          customReportsApi.getAll().catch(() => []),
          investmentReportsApi.getAll().catch(() => []),
        ]);
        setManagedFavourites([
          ...custom
            .filter((cr) => cr.isFavourite)
            .map((cr) => ({
              id: `custom/${cr.id}`,
              name: cr.name,
              category: 'custom' as ReportCategory,
              color: cr.backgroundColor ? '' : 'bg-purple-500',
              backgroundColor: cr.backgroundColor,
              icon: (cr.icon && getIconComponent(cr.icon)) || fallbackReportIcon,
            })),
          ...investment
            .filter((ir) => ir.isFavourite)
            .map((ir) => ({
              id: `investment/${ir.id}`,
              name: ir.name,
              category: 'investment' as ReportCategory,
              color: ir.backgroundColor ? '' : 'bg-lime-500',
              backgroundColor: ir.backgroundColor,
              icon: (ir.icon && getIconComponent(ir.icon)) || fallbackReportIcon,
            })),
        ]);
      } catch (error) {
        logger.error('Failed to load favourite custom reports:', error);
      } finally {
        setIsLoadingManaged(false);
      }
    };

    loadManagedFavourites();
  }, [parentLoading]);

  const favourites = useMemo<FavouriteReportEntry[]>(() => {
    const builtIn = (favouriteReportIds ?? [])
      .map((id) => builtInReports.find((r) => r.id === id))
      .filter((r): r is (typeof builtInReports)[number] => !!r)
      .map((r) => ({ id: r.id, category: r.category, color: r.color, icon: r.icon }));
    return [...builtIn, ...managedFavourites];
  }, [favouriteReportIds, managedFavourites]);

  const sectionTitle = (
    <button
      onClick={() => router.push('/reports')}
      className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
    >
      {t('favouriteReports.title')}
    </button>
  );

  if (parentLoading || isLoadingManaged) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        {sectionTitle}
        <div className="animate-pulse space-y-3">
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      {sectionTitle}
      {favourites.length === 0 ? (
        <>
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            {t('favouriteReports.empty')}
          </p>
          <button
            onClick={() => router.push('/reports')}
            className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            {t('favouriteReports.browseReports')}
          </button>
        </>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {favourites.map((report) => (
            <li key={report.id}>
              <button
                onClick={() => router.push(`/reports/${report.id}`)}
                className="w-full flex items-center gap-3 py-2 px-1 text-left rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group"
              >
                <div
                  className={`${!report.backgroundColor ? `${report.color} bg-opacity-20 dark:bg-opacity-30` : ''} rounded p-1.5 flex-shrink-0 flex items-center justify-center`}
                  style={report.backgroundColor ? { backgroundColor: `${report.backgroundColor}40` } : undefined}
                >
                  <div className="text-gray-700 dark:text-gray-200 [&>svg]:h-5 [&>svg]:w-5">
                    {report.icon}
                  </div>
                </div>
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  {report.name ??
                    tReports(`page.names.${report.id}` as Parameters<typeof tReports>[0])}
                </span>
                <span className={`px-2 py-0.5 text-xs font-medium rounded flex-shrink-0 ${categoryColors[report.category]}`}>
                  {tReports(`page.categories.${report.category}` as Parameters<typeof tReports>[0])}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
