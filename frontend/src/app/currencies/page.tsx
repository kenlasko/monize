'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { Pagination } from '@/components/ui/Pagination';
import { CARD_CLASS } from '@/components/ui/Card';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import dynamic from 'next/dynamic';
import { exchangeRatesApi, CurrencyInfo, CreateCurrencyData, CurrencyUsage, FxProviderDescription, isFxProviderName } from '@/lib/exchange-rates';
const CurrencyForm = dynamic(() => import('@/components/currencies/CurrencyForm').then(m => m.CurrencyForm), { ssr: false });
import { CurrencyList, type CurrencySortField, type SortDirection } from '@/components/currencies/CurrencyList';
import { RateHistoryCoverage } from '@/components/currencies/RateHistoryCoverage';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { PAGE_SIZE } from '@/lib/constants';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Currencies');

export default function CurrenciesPage() {
  return (
    <ProtectedRoute>
      <CurrenciesContent />
    </ProtectedRoute>
  );
}

function CurrenciesContent() {
  const t = useTranslations('currencies');
  const tc = useTranslations('common');
  const [allCurrencies, setAllCurrencies] = useState<CurrencyInfo[]>([]);
  const [usage, setUsage] = useState<CurrencyUsage>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingRates, setIsRefreshingRates] = useState(false);
  // The currency whose stored rate history is open, or null. Its own dialog,
  // because the built-in currencies have no edit dialog to host it in.
  const [rateHistoryCurrency, setRateHistoryCurrency] = useState<CurrencyInfo | null>(null);
  const { showForm, editingItem: editingCurrency, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<CurrencyInfo>();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useLocalStorage<CurrencySortField>('monize-currencies-sort-field', 'code');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-currencies-sort-dir', 'asc');

  // The configured FX providers in the order the server asks them; empty until
  // the status answers, and left empty if it does not (the line is omitted).
  const [fxProviders, setFxProviders] = useState<FxProviderDescription[]>([]);
  // When the stored rates were last fetched, shown on Refresh Rates; null when
  // the server has none, undefined until the status answers.
  const [ratesLastUpdated, setRatesLastUpdated] = useState<string | null | undefined>(undefined);
  const formatRelativeTime = useRelativeTime();

  const { defaultCurrency, getRate, refresh: refreshRates } = useExchangeRates();

  useEffect(() => {
    let cancelled = false;
    exchangeRatesApi
      .getRateStatus()
      .then((status) => {
        if (cancelled) return;
        setFxProviders(status?.providers ?? []);
        setRatesLastUpdated(status?.lastUpdated ?? null);
      })
      .catch((error) => logger.error(error));
    return () => {
      cancelled = true;
    };
  }, []);

  // A name this client has no label for still shows, as the server's token.
  const fxProviderLine = fxProviders.length
    ? t('page.providers.line', {
        providers: fxProviders
          .map((p) => (isFxProviderName(p.name) ? t(`page.providers.names.${p.name}`) : p.name))
          .join(t('page.providers.separator')),
      })
    : null;

  // Always fetch all currencies so summary cards show correct totals
  // The mount load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const [currenciesData, usageData] = await Promise.all([
          exchangeRatesApi.getCurrencies(true),
          exchangeRatesApi.getCurrencyUsage(),
        ]);
        setAllCurrencies(currenciesData);
        setUsage(usageData);
      } catch (error) {
        toast.error(t('page.toasts.loadFailed'));
        logger.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useOnUndoRedo(loadData);
  // Refresh on AI chat-bubble writes the same way as undo/redo.
  useOnAiAction(loadData);

  const handleCreateNew = () => {
    openCreate();
  };

  const handleEdit = (currency: CurrencyInfo) => {
    openEdit(currency);
  };

  const handleFormSubmit = async (data: CreateCurrencyData) => {
    try {
      if (editingCurrency) {
        // `code` is immutable: the backend's UpdateCurrencyDto omits it and
        // rejects unknown fields (forbidNonWhitelisted), so send only the
        // editable fields rather than the whole create payload.
        await exchangeRatesApi.updateCurrency(editingCurrency.code, {
          name: data.name,
          symbol: data.symbol,
          decimalPlaces: data.decimalPlaces,
        });
        toast.success(t('page.toasts.updated'));
      } else {
        await exchangeRatesApi.createCurrency(data);
        toast.success(t('page.toasts.created'));
      }
      close();
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, editingCurrency ? t('page.toasts.updateFailed') : t('page.toasts.createFailed')));
      throw error;
    }
  };

  const handleToggleActive = async (currency: CurrencyInfo) => {
    try {
      if (currency.isActive) {
        await exchangeRatesApi.deactivateCurrency(currency.code);
        toast.success(t('page.toasts.deactivated'));
      } else {
        await exchangeRatesApi.activateCurrency(currency.code);
        toast.success(t('page.toasts.activated'));
      }
      // Update inline without full reload to preserve scroll position
      setAllCurrencies(prev =>
        prev.map(c => c.code === currency.code ? { ...c, isActive: !currency.isActive } : c)
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.statusFailed')));
    }
  };

  const reloadRatesAge = async () => {
    try {
      const status = await exchangeRatesApi.getRateStatus();
      setRatesLastUpdated(status?.lastUpdated ?? null);
    } catch (error) {
      logger.error(error);
    }
  };

  const handleRefreshRates = async () => {
    setIsRefreshingRates(true);
    try {
      const summary = await exchangeRatesApi.refreshRates();
      const updated = summary?.updated ?? 0;
      const failed = summary?.failed ?? 0;
      if (updated === 0 && failed > 0) {
        // Every pair failed: nothing was refreshed, so this is not a success.
        toast.error(t('page.toasts.ratesAllFailed'));
      } else if (failed > 0) {
        toast.success(t('page.toasts.ratesRefreshedWithFailed', { updated, failed }));
      } else {
        toast.success(t('page.toasts.ratesRefreshed', { updated }));
      }
      // Reload rates and currency data so the list reflects updated values
      await Promise.all([refreshRates(), loadData(), reloadRatesAge()]);
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.ratesFailed')));
    } finally {
      setIsRefreshingRates(false);
    }
  };

  // Apply status filter
  const statusFilteredCurrencies = useMemo(() => {
    if (statusFilter === 'all') return allCurrencies;
    return allCurrencies.filter(c => statusFilter === 'active' ? c.isActive : !c.isActive);
  }, [allCurrencies, statusFilter]);

  // Filter by search
  const filteredCurrencies = useMemo(() => {
    if (!searchQuery) return statusFilteredCurrencies;
    const q = searchQuery.toLowerCase();
    return statusFilteredCurrencies.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }, [statusFilteredCurrencies, searchQuery]);

  // Sort
  const sortedCurrencies = useMemo(() => {
    return [...filteredCurrencies].sort((a, b) => {
      // Default currency always first
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;

      let comparison = 0;
      if (sortField === 'code') {
        comparison = a.code.localeCompare(b.code, undefined, { sensitivity: 'base' });
      } else if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'symbol') {
        comparison = a.symbol.localeCompare(b.symbol, undefined, { sensitivity: 'base' });
      } else if (sortField === 'decimals') {
        comparison = a.decimalPlaces - b.decimalPlaces;
      } else if (sortField === 'rate') {
        const rateA = getRate(a.code) ?? 0;
        const rateB = getRate(b.code) ?? 0;
        comparison = rateA - rateB;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredCurrencies, sortField, sortDirection, defaultCurrency, getRate]);

  // Pagination
  const totalPages = Math.ceil(sortedCurrencies.length / PAGE_SIZE);
  const paginatedCurrencies = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sortedCurrencies.slice(start, start + PAGE_SIZE);
  }, [sortedCurrencies, currentPage]);

  // A new search or status filter starts again from the first page.
  const handleSearchChange = (query: string) => {
    if (query !== searchQuery) setCurrentPage(1);
    setSearchQuery(query);
  };

  const handleStatusFilterChange = (status: 'all' | 'active' | 'inactive') => {
    if (status !== statusFilter) setCurrentPage(1);
    setStatusFilter(status);
  };

  const handleSort = useCallback((field: CurrencySortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setCurrentPage(1);
  }, [sortField, setSortField, setSortDirection]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  // Summary counts always reflect all currencies, not just visible ones
  const activeCount = allCurrencies.filter((c) => c.isActive).length;
  const inactiveCount = allCurrencies.filter((c) => !c.isActive).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('currencies')}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleRefreshRates}
                isLoading={isRefreshingRates}
                className="gap-1.5 whitespace-nowrap"
              >
                {isRefreshingRates ? (
                  t('page.refreshing')
                ) : (
                  <>
                    <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
                    {t('page.refreshRates')}
                    {ratesLastUpdated && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('page.ratesAge', { time: formatRelativeTime(ratesLastUpdated) })}
                      </span>
                    )}
                  </>
                )}
              </Button>
              <Button onClick={handleCreateNew}>{t('page.newCurrency')}</Button>
            </div>
          }
        />

        {fxProviderLine && (
          <p data-testid="fx-provider-line" className="-mt-4 mb-6 text-sm text-gray-500 dark:text-gray-400">
            {fxProviderLine}
          </p>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard label={t('page.summary.totalCurrencies')} value={allCurrencies.length} icon={SummaryIcons.barChart} />
          <SummaryCard label={t('page.summary.active')} value={activeCount} icon={SummaryIcons.checkCircle} valueColor="green" />
          <SummaryCard label={t('page.summary.inactive')} value={inactiveCount} icon={SummaryIcons.ban} />
        </div>

        {/* Search and Status Filter */}
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            aria-label={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="block w-full sm:w-auto sm:flex-1 sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
          <div role="group" aria-label={t('page.statusFilterLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
            {(['all', 'active', 'inactive'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => handleStatusFilterChange(status)}
                aria-pressed={statusFilter === status}
                className={toolbarSegmentClass(statusFilter === status)}
              >
                {status === 'active' ? t('page.statusActive', { count: activeCount }) :
                 status === 'inactive' ? t('page.statusInactive', { count: inactiveCount }) :
                 t('page.statusAll', { count: allCurrencies.length })}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="lg"
          className="p-6"
          title={isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
        >
          <CurrencyForm
            currency={editingCurrency}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Rate history dialog */}
        <Modal
          isOpen={!!rateHistoryCurrency}
          onClose={() => setRateHistoryCurrency(null)}
          maxWidth="lg"
          className="p-6"
          title={rateHistoryCurrency?.code}
          footer={
            <Button variant="outline" onClick={() => setRateHistoryCurrency(null)}>
              {tc('close')}
            </Button>
          }
        >
          {/* The dialog a reader opened to see the rates is where they are
              listed; the currency form keeps the summary alone. */}
          {rateHistoryCurrency && (
            <RateHistoryCoverage code={rateHistoryCurrency.code} showStoredRates />
          )}
        </Modal>

        {/* Currencies List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <CurrencyList
              currencies={paginatedCurrencies}
              usage={usage}
              defaultCurrency={defaultCurrency}
              getRate={getRate}
              onEdit={handleEdit}
              onToggleActive={handleToggleActive}
              onRateHistory={setRateHistoryCurrency}
              onRefresh={loadData}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={sortedCurrencies.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="currencies"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {totalPages <= 1 && sortedCurrencies.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('page.count', { count: sortedCurrencies.length })}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
