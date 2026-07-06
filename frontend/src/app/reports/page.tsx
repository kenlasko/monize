'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { NewReportButton } from '@/components/reports/NewReportButton';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { customReportsApi } from '@/lib/custom-reports';
import { CustomReport } from '@/types/custom-report';
import { investmentReportsApi } from '@/lib/investment-reports';
import { InvestmentReport } from '@/types/investment-report';
import { getIconComponent } from '@/components/ui/IconPicker';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import {
  Report,
  ReportCategory,
  builtInReports,
  categoryColors,
} from '@/components/reports/report-definitions';

import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';

const logger = createLogger('Reports');

export default function ReportsPage() {
  return (
    <ProtectedRoute>
      <ReportsContent />
    </ProtectedRoute>
  );
}

function ReportsContent() {
  const t = useTranslations('reports');
  const router = useRouter();
  const [density, setDensity] = useLocalStorage<DensityLevel>('monize-reports-density', 'normal');
  const [categoryFilter, setCategoryFilter] = useLocalStorage<ReportCategory | 'all'>('monize-reports-category', 'all');
  const [searchQuery, setSearchQuery] = useState('');
  const [customReports, setCustomReports] = useState<CustomReport[]>([]);
  const [isLoadingCustom, setIsLoadingCustom] = useState(true);
  const [investmentReports, setInvestmentReports] = useState<InvestmentReport[]>([]);
  const preferences = usePreferencesStore((s) => s.preferences);
  const updateStorePreferences = usePreferencesStore((s) => s.updatePreferences);
  const loadPreferences = usePreferencesStore((s) => s.loadPreferences);
  // Memoized so the `??[]` fallback does not create a new array reference each
  // render, which would otherwise invalidate the filteredReports memo.
  const favouriteReportIds = useMemo(
    () => preferences?.favouriteReportIds ?? [],
    [preferences?.favouriteReportIds],
  );

  // Refresh preferences from server on mount to pick up changes from other devices
  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  // One-time migration: move localStorage favourites to backend
  useEffect(() => {
    const stored = localStorage.getItem('monize-favourite-reports');
    if (!stored || !preferences) return;
    try {
      const ids = JSON.parse(stored) as string[];
      if (!Array.isArray(ids) || ids.length === 0) {
        localStorage.removeItem('monize-favourite-reports');
        return;
      }
      // Fetch latest from server to merge correctly with other devices
      userSettingsApi.getPreferences().then((serverPrefs) => {
        const serverIds = serverPrefs.favouriteReportIds ?? [];
        const merged = [...new Set([...serverIds, ...ids])];
        updateStorePreferences({ favouriteReportIds: merged });
        return userSettingsApi.updatePreferences({ favouriteReportIds: merged });
      }).then(() => {
        localStorage.removeItem('monize-favourite-reports');
      }).catch((error) => {
        logger.error('Failed to migrate favourite reports:', error);
      });
    } catch {
      localStorage.removeItem('monize-favourite-reports');
    }
  }, [preferences !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const loadCustomReports = async () => {
      try {
        const data = await customReportsApi.getAll();
        setCustomReports(data);
      } catch (error) {
        logger.error('Failed to load custom reports:', error);
      } finally {
        setIsLoadingCustom(false);
      }
    };
    loadCustomReports();
  }, []);

  useEffect(() => {
    const loadInvestmentReports = async () => {
      try {
        const data = await investmentReportsApi.getAll();
        setInvestmentReports(data);
      } catch (error) {
        logger.error('Failed to load investment reports:', error);
      }
    };
    loadInvestmentReports();
  }, []);

  const cycleDensity = () => setDensity(nextDensity(density));

  const managedBackgroundColor = (report: Report): string => {
    if (report.isCustom) {
      return (
        customReports.find((cr) => `custom/${cr.id}` === report.id)?.backgroundColor || ''
      );
    }
    if (report.isInvestment) {
      return (
        investmentReports.find((ir) => `investment/${ir.id}` === report.id)
          ?.backgroundColor || ''
      );
    }
    return '';
  };

  const isReportFavourite = (report: Report): boolean => {
    if (report.isCustom || report.isInvestment) {
      return report.isFavourite ?? false;
    }
    return favouriteReportIds.includes(report.id);
  };

  const handleToggleFavourite = async (e: React.MouseEvent, report: Report) => {
    e.stopPropagation();
    if (report.isCustom) {
      const cr = customReports.find(c => `custom/${c.id}` === report.id);
      if (!cr) return;
      const newValue = !cr.isFavourite;
      try {
        await customReportsApi.toggleFavourite(cr.id, newValue);
        setCustomReports(prev => prev.map(c => c.id === cr.id ? { ...c, isFavourite: newValue } : c));
      } catch (error) {
        logger.error('Failed to toggle favourite:', error);
      }
    } else if (report.isInvestment) {
      const ir = investmentReports.find(c => `investment/${c.id}` === report.id);
      if (!ir) return;
      const newValue = !ir.isFavourite;
      try {
        await investmentReportsApi.toggleFavourite(ir.id, newValue);
        setInvestmentReports(prev => prev.map(c => c.id === ir.id ? { ...c, isFavourite: newValue } : c));
      } catch (error) {
        logger.error('Failed to toggle favourite:', error);
      }
    } else {
      const wasFavourite = favouriteReportIds.includes(report.id);
      // Optimistic update for immediate UI feedback
      const optimistic = wasFavourite
        ? favouriteReportIds.filter(id => id !== report.id)
        : [...favouriteReportIds, report.id];
      updateStorePreferences({ favouriteReportIds: optimistic });
      try {
        // Fetch latest from server to avoid overwriting other devices' changes
        const serverPrefs = await userSettingsApi.getPreferences();
        const serverIds = serverPrefs.favouriteReportIds ?? [];
        const updated = wasFavourite
          ? serverIds.filter(id => id !== report.id)
          : serverIds.includes(report.id) ? serverIds : [...serverIds, report.id];
        const saved = await userSettingsApi.updatePreferences({ favouriteReportIds: updated });
        updateStorePreferences({ favouriteReportIds: saved.favouriteReportIds });
      } catch (error) {
        logger.error('Failed to update favourite reports:', error);
        updateStorePreferences({ favouriteReportIds: favouriteReportIds });
      }
    }
  };

  const densityLabels: Record<DensityLevel, string> = {
    normal: t('page.density.normal'),
    compact: t('page.density.compact'),
    dense: t('page.density.dense'),
  };

  // Convert custom reports to the Report interface. Memoized so the SVG icon
  // nodes are not rebuilt on every render (e.g. each search keystroke).
  const customReportsAsReports: Report[] = useMemo(
    () =>
      customReports.map((cr) => {
        const iconNode = cr.icon ? getIconComponent(cr.icon) : null;
        return {
          id: `custom/${cr.id}`,
          name: cr.name,
          description: cr.description || `${t(`customReportLabels.viewType.${cr.viewType}`)} · ${t(`customReportLabels.timeframe.${cr.timeframeType}`)}`,
          category: 'custom' as ReportCategory,
          color: cr.backgroundColor ? '' : 'bg-purple-500',
          isCustom: true,
          isFavourite: cr.isFavourite,
          icon: iconNode || (
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          ),
        };
      }),
    [customReports, t],
  );

  // Convert investment reports to the Report interface (memoized, see above).
  const investmentReportsAsReports: Report[] = useMemo(
    () =>
      investmentReports.map((ir) => {
        const iconNode = ir.icon ? getIconComponent(ir.icon) : null;
        return {
          id: `investment/${ir.id}`,
          name: ir.name,
          description:
            ir.description ||
            `Investment report · ${ir.config.columns?.length ?? 0} columns`,
          category: 'investment' as ReportCategory,
          color: ir.backgroundColor ? '' : 'bg-lime-500',
          isInvestment: true,
          isFavourite: ir.isFavourite,
          icon: iconNode || (
            <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
          ),
        };
      }),
    [investmentReports],
  );

  const allReports = useMemo(
    () => [...builtInReports, ...customReportsAsReports, ...investmentReportsAsReports],
    [customReportsAsReports, investmentReportsAsReports],
  );

  // Debounce the search term so filter + sort does not re-run on every
  // keystroke. The input stays bound to the immediate `searchQuery` value.
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);

  const getReportName = (report: Report): string =>
    report.name ?? t(`page.names.${report.id}` as Parameters<typeof t>[0]);
  const getReportDescription = (report: Report): string =>
    report.description ?? t(`page.descriptions.${report.id}` as Parameters<typeof t>[0]);

  const filteredReports = useMemo(() => {
    const isFavourite = (report: Report): boolean =>
      report.isCustom || report.isInvestment
        ? report.isFavourite ?? false
        : favouriteReportIds.includes(report.id);
    const q = debouncedSearchQuery.toLowerCase();
    return allReports
      .filter(r => {
        if (categoryFilter !== 'all' && r.category !== categoryFilter) return false;
        if (debouncedSearchQuery) {
          const name = r.name ?? t(`page.names.${r.id}` as Parameters<typeof t>[0]);
          const desc = r.description ?? t(`page.descriptions.${r.id}` as Parameters<typeof t>[0]);
          return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
        }
        return true;
      })
      .sort((a, b) => Number(isFavourite(b)) - Number(isFavourite(a)));
  }, [allReports, categoryFilter, debouncedSearchQuery, favouriteReportIds, t]);

  const handleReportClick = (reportId: string) => {
    router.push(`/reports/${reportId}`);
  };

  return (
    <PageLayout>

      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/Reports"
          actions={
            <NewReportButton
              onNewStandard={() => router.push('/reports/custom/new')}
              onNewInvestment={() => router.push('/reports/investment/new')}
            />
          }
        />
        {/* Search */}
        <div className="mb-4">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400 font-sans"
          />
        </div>

        {/* Category Filter */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setCategoryFilter('all')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              categoryFilter === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600'
            }`}
          >
            {t('page.allReports')}
          </button>
          {(Object.keys(categoryColors) as ReportCategory[]).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                categoryFilter === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600'
              }`}
            >
              {t(`page.categories.${cat}` as Parameters<typeof t>[0])}
            </button>
          ))}
          <button
            onClick={cycleDensity}
            className="ml-auto inline-flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            title={t('page.densityTitle', { nextDensity: densityLabels[nextDensity(density)] })}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            {densityLabels[density]}
          </button>
        </div>

        {/* Reports Grid */}
        {density === 'normal' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredReports.map((report) => {
              const bgColor = managedBackgroundColor(report);
              const colorClass = report.color || 'bg-purple-500';

              return (
                <button
                  key={report.id}
                  onClick={() => handleReportClick(report.id)}
                  className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden hover:shadow-lg dark:hover:shadow-gray-700/70 transition-shadow text-left group flex flex-col h-full"
                >
                  {/* Preview Area */}
                  <div
                    className={`h-32 ${!bgColor ? `${colorClass} bg-opacity-10 dark:bg-opacity-20` : ''} flex items-center justify-center relative flex-shrink-0`}
                    style={bgColor ? { backgroundColor: `${bgColor}20` } : undefined}
                  >
                    <div
                      className={`${!bgColor ? `${colorClass} bg-opacity-20 dark:bg-opacity-30` : ''} rounded-full p-4`}
                      style={bgColor ? { backgroundColor: `${bgColor}40` } : undefined}
                    >
                      <div className="text-gray-700 dark:text-gray-200">
                        {report.icon}
                      </div>
                    </div>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleToggleFavourite(e, report)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleFavourite(e as unknown as React.MouseEvent, report); } }}
                      className="absolute top-3 left-3 p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                      title={isReportFavourite(report) ? t('page.removeFavourite') : t('page.addFavourite')}
                    >
                      <svg
                        className={`w-5 h-5 ${isReportFavourite(report) ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-500'}`}
                        fill={isReportFavourite(report) ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    </div>
                    <span className={`absolute top-3 right-3 px-2 py-1 text-xs font-medium rounded ${categoryColors[report.category]}`}>
                      {t(`page.categories.${report.category}` as Parameters<typeof t>[0])}
                    </span>
                  </div>
                  {/* Content */}
                  <div className="p-4 flex flex-col flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                      {getReportName(report)}
                    </h3>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                      {getReportDescription(report)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {density === 'compact' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredReports.map((report) => {
              const bgColor = managedBackgroundColor(report);
              const colorClass = report.color || 'bg-purple-500';

              return (
                <button
                  key={report.id}
                  onClick={() => handleReportClick(report.id)}
                  className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 hover:shadow-md dark:hover:shadow-gray-700/70 transition-shadow text-left flex items-center gap-4 group"
                >
                  <div
                    className={`${!bgColor ? `${colorClass} bg-opacity-20 dark:bg-opacity-30` : ''} rounded-lg p-3 flex-shrink-0`}
                    style={bgColor ? { backgroundColor: `${bgColor}40` } : undefined}
                  >
                    <div className="text-gray-700 dark:text-gray-200">
                      {report.icon}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                        {getReportName(report)}
                      </h3>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${categoryColors[report.category]} flex-shrink-0`}>
                        {t(`page.categories.${report.category}` as Parameters<typeof t>[0])}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-1">
                      {getReportDescription(report)}
                    </p>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => handleToggleFavourite(e, report)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleFavourite(e as unknown as React.MouseEvent, report); } }}
                    className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
                    title={isReportFavourite(report) ? t('page.removeFavourite') : t('page.addFavourite')}
                  >
                    <svg
                      className={`w-4 h-4 ${isReportFavourite(report) ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-500'}`}
                      fill={isReportFavourite(report) ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {density === 'dense' && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="w-10 px-2 py-3"></th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {t('page.tableReport')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    {t('page.tableCategory')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">
                    {t('page.tableDescription')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredReports.map((report) => {
                  const bgColor = managedBackgroundColor(report);
                  const colorClass = report.color || 'bg-purple-500';

                  return (
                    <tr
                      key={report.id}
                      onClick={() => handleReportClick(report.id)}
                      className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                    >
                      <td className="px-2 py-3 text-center">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggleFavourite(e, report); }}
                          className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          title={isReportFavourite(report) ? t('page.removeFavourite') : t('page.addFavourite')}
                        >
                          <svg
                            className={`w-4 h-4 ${isReportFavourite(report) ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-500'}`}
                            fill={isReportFavourite(report) ? 'currentColor' : 'none'}
                            stroke="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={`${!bgColor ? `${colorClass} bg-opacity-20 dark:bg-opacity-30` : ''} rounded p-1.5 flex-shrink-0 hidden md:flex items-center justify-center`}
                            style={bgColor ? { backgroundColor: `${bgColor}40` } : undefined}
                          >
                            <div className="text-gray-700 dark:text-gray-200 [&>svg]:h-5 [&>svg]:w-5">
                              {report.icon}
                            </div>
                          </div>
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {getReportName(report)}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${categoryColors[report.category]}`}>
                          {t(`page.categories.${report.category}` as Parameters<typeof t>[0])}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">
                        {getReportDescription(report)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Report Count */}
        <div className="mt-6 text-sm text-gray-500 dark:text-gray-400 text-center">
          {t('page.reportCount', { count: filteredReports.length })}
          {isLoadingCustom && ` ${t('page.loadingCustom')}`}
        </div>
      </main>
    </PageLayout>
  );
}
