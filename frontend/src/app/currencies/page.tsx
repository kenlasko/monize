'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { Modal } from '@/components/ui/Modal';
import { Pagination } from '@/components/ui/Pagination';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import dynamic from 'next/dynamic';
import { exchangeRatesApi, CurrencyInfo, CreateCurrencyData, CurrencyUsage } from '@/lib/exchange-rates';
const CurrencyForm = dynamic(() => import('@/components/currencies/CurrencyForm').then(m => m.CurrencyForm), { ssr: false });
import { CurrencyList, DensityLevel } from '@/components/currencies/CurrencyList';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Currencies');

const PAGE_SIZE = 50;

export default function CurrenciesPage() {
  return (
    <ProtectedRoute>
      <CurrenciesContent />
    </ProtectedRoute>
  );
}

function CurrenciesContent() {
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [usage, setUsage] = useState<CurrencyUsage>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingRates, setIsRefreshingRates] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<CurrencyInfo | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-currencies-density', 'normal');

  const { defaultCurrency, getRate, refresh: refreshRates } = useExchangeRates();

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [currenciesData, usageData] = await Promise.all([
        exchangeRatesApi.getCurrencies(showInactive),
        exchangeRatesApi.getCurrencyUsage(),
      ]);
      setCurrencies(currenciesData);
      setUsage(usageData);
    } catch (error) {
      toast.error('Failed to load currencies');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [showInactive]);

  const handleCreateNew = () => {
    setEditingCurrency(undefined);
    setShowForm(true);
  };

  const handleEdit = (currency: CurrencyInfo) => {
    setEditingCurrency(currency);
    setShowForm(true);
  };

  const handleFormSubmit = async (data: CreateCurrencyData) => {
    try {
      if (editingCurrency) {
        await exchangeRatesApi.updateCurrency(editingCurrency.code, data);
        toast.success('Currency updated successfully');
      } else {
        await exchangeRatesApi.createCurrency(data);
        toast.success('Currency created successfully');
      }
      setShowForm(false);
      setEditingCurrency(undefined);
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingCurrency ? 'update' : 'create'} currency`));
      throw error;
    }
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingCurrency(undefined);
  };

  const handleToggleActive = async (currency: CurrencyInfo) => {
    try {
      if (currency.isActive) {
        await exchangeRatesApi.deactivateCurrency(currency.code);
        toast.success('Currency deactivated');
      } else {
        await exchangeRatesApi.activateCurrency(currency.code);
        toast.success('Currency activated');
      }
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update currency status'));
    }
  };

  const handleRefreshRates = async () => {
    setIsRefreshingRates(true);
    try {
      const summary = await exchangeRatesApi.refreshRates();
      const updated = summary?.updated ?? 0;
      const failed = summary?.failed ?? 0;
      if (failed > 0) {
        toast.success(`Exchange rates refreshed: ${updated} updated, ${failed} failed`);
      } else {
        toast.success(`Exchange rates refreshed: ${updated} pairs updated`);
      }
      // Reload rates into the UI so the list reflects updated values
      await refreshRates();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to refresh exchange rates'));
    } finally {
      setIsRefreshingRates(false);
    }
  };

  // Sort: default currency first, then alphabetical
  const sortedCurrencies = useMemo(() => {
    return [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
  }, [currencies, defaultCurrency]);

  // Filter by search
  const filteredCurrencies = useMemo(() => {
    if (!searchQuery) return sortedCurrencies;
    const q = searchQuery.toLowerCase();
    return sortedCurrencies.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }, [sortedCurrencies, searchQuery]);

  // Pagination
  const totalPages = Math.ceil(filteredCurrencies.length / PAGE_SIZE);
  const paginatedCurrencies = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredCurrencies.slice(start, start + PAGE_SIZE);
  }, [filteredCurrencies, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, showInactive]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const activeCount = currencies.filter((c) => c.isActive).length;
  const inactiveCount = currencies.filter((c) => !c.isActive).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader
          title="Currencies"
          subtitle="Manage currencies used across your accounts and securities"
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleRefreshRates}
                disabled={isRefreshingRates}
              >
                {isRefreshingRates ? 'Refreshing...' : 'Refresh Rates'}
              </Button>
              <Button onClick={handleCreateNew}>+ New Currency</Button>
            </div>
          }
        />

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard label="Total Currencies" value={currencies.length} icon={SummaryIcons.barChart} />
          <SummaryCard label="Active" value={activeCount} icon={SummaryIcons.checkCircle} valueColor="green" />
          <SummaryCard label="Inactive" value={inactiveCount} icon={SummaryIcons.ban} />
        </div>

        {/* Search and Filters */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search by code or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400 font-sans"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-800"
            />
            Show inactive currencies
          </label>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleFormCancel} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingCurrency ? 'Edit Currency' : 'New Currency'}
          </h2>
          <CurrencyForm
            currency={editingCurrency}
            onSubmit={handleFormSubmit}
            onCancel={handleFormCancel}
          />
        </Modal>

        {/* Currencies List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading currencies..." />
          ) : (
            <CurrencyList
              currencies={paginatedCurrencies}
              usage={usage}
              defaultCurrency={defaultCurrency}
              getRate={getRate}
              onEdit={handleEdit}
              onToggleActive={handleToggleActive}
              onRefresh={loadData}
              density={listDensity}
              onDensityChange={setListDensity}
            />
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filteredCurrencies.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="currencies"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {totalPages <= 1 && filteredCurrencies.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {filteredCurrencies.length} currenc{filteredCurrencies.length !== 1 ? 'ies' : 'y'}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
