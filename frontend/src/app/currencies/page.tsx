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
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import dynamic from 'next/dynamic';
import { exchangeRatesApi, CurrencyInfo, CreateCurrencyData, CurrencyUsage } from '@/lib/exchange-rates';
const CurrencyForm = dynamic(() => import('@/components/currencies/CurrencyForm').then(m => m.CurrencyForm), { ssr: false });
import { CurrencyList, type CurrencySortField, type SortDirection } from '@/components/currencies/CurrencyList';
import { type DensityLevel } from '@/hooks/useTableDensity';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useFormModal } from '@/hooks/useFormModal';
import { PAGE_SIZE } from '@/lib/constants';

const logger = createLogger('Currencies');

export default function CurrenciesPage() {
  return (
    <ProtectedRoute>
      <CurrenciesContent />
    </ProtectedRoute>
  );
}

function CurrenciesContent() {
  const [allCurrencies, setAllCurrencies] = useState<CurrencyInfo[]>([]);
  const [usage, setUsage] = useState<CurrencyUsage>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingRates, setIsRefreshingRates] = useState(false);
  const { showForm, editingItem: editingCurrency, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<CurrencyInfo>();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-currencies-density', 'normal');
  const [sortField, setSortField] = useLocalStorage<CurrencySortField>('monize-currencies-sort-field', 'code');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-currencies-sort-dir', 'asc');

  const { defaultCurrency, getRate, refresh: refreshRates } = useExchangeRates();

  // Always fetch all currencies so summary cards show correct totals
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [currenciesData, usageData] = await Promise.all([
        exchangeRatesApi.getCurrencies(true),
        exchangeRatesApi.getCurrencyUsage(),
      ]);
      setAllCurrencies(currenciesData);
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
  }, []);

  const handleCreateNew = () => {
    openCreate();
  };

  const handleEdit = (currency: CurrencyInfo) => {
    openEdit(currency);
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
      close();
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingCurrency ? 'update' : 'create'} currency`));
      throw error;
    }
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
      // Reload rates and currency data so the list reflects updated values
      await Promise.all([refreshRates(), loadData()]);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to refresh exchange rates'));
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

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

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
          title="Currencies"
          subtitle="Manage currencies used across your accounts and securities"
          helpUrl="https://github.com/kenlasko/monize/wiki/Currency-Management"
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
          <SummaryCard label="Total Currencies" value={allCurrencies.length} icon={SummaryIcons.barChart} />
          <SummaryCard label="Active" value={activeCount} icon={SummaryIcons.checkCircle} valueColor="green" />
          <SummaryCard label="Inactive" value={inactiveCount} icon={SummaryIcons.ban} />
        </div>

        {/* Search and Status Filter */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search by code or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
          <div className="flex rounded-md shadow-sm">
            {(['all', 'active', 'inactive'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-2 text-sm font-medium border ${
                  statusFilter === status
                    ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                } ${
                  status === 'all' ? 'rounded-l-md' : ''
                } ${
                  status === 'inactive' ? 'rounded-r-md' : ''
                } ${
                  status !== 'all' ? '-ml-px' : ''
                }`}
              >
                {status === 'active' ? `Active (${activeCount})` :
                 status === 'inactive' ? `Inactive (${inactiveCount})` :
                 `All (${allCurrencies.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Currency' : 'New Currency'}
          </h2>
          <CurrencyForm
            currency={editingCurrency}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

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
            {sortedCurrencies.length} currenc{sortedCurrencies.length !== 1 ? 'ies' : 'y'}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
