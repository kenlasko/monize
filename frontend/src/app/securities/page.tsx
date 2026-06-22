'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
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
import { investmentsApi } from '@/lib/investments';
import { Security, CreateSecurityData, Holding } from '@/types/investment';
const SecurityForm = dynamic(() => import('@/components/securities/SecurityForm').then(m => m.SecurityForm), { ssr: false });
const SecurityPriceHistory = dynamic(() => import('@/components/securities/SecurityPriceHistory').then(m => m.SecurityPriceHistory), { ssr: false });
const SecurityTransactionHistory = dynamic(() => import('@/components/securities/SecurityTransactionHistory').then(m => m.SecurityTransactionHistory), { ssr: false });
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SecurityList, type SecurityHoldings, type SecurityTransactions, type SecuritySortField, type SortDirection } from '@/components/securities/SecurityList';
import { type DensityLevel } from '@/hooks/useTableDensity';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { PAGE_SIZE } from '@/lib/constants';

const logger = createLogger('Securities');

export default function SecuritiesPage() {
  return (
    <ProtectedRoute>
      <SecuritiesContent />
    </ProtectedRoute>
  );
}

function SecuritiesContent() {
  const t = useTranslations('securities');
  const [allSecurities, setAllSecurities] = useState<Security[]>([]);
  const [holdings, setHoldings] = useState<SecurityHoldings>({});
  const [transactionSecurityIds, setTransactionSecurityIds] = useState<SecurityTransactions>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; security: Security | null }>({
    isOpen: false,
    security: null,
  });
  const { showForm, editingItem: editingSecurity, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Security>();
  const [priceSecurity, setPriceSecurity] = useState<Security | undefined>();
  const [historySecurity, setHistorySecurity] = useState<Security | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-securities-density', 'normal');
  const [sortField, setSortField] = useLocalStorage<SecuritySortField>('monize-securities-sort-field', 'symbol');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-securities-sort-dir', 'asc');

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [data, holdingsData, usedIds] = await Promise.all([
        investmentsApi.getSecurities(true),
        investmentsApi.getHoldings(),
        investmentsApi.getUsedSecurityIds(),
      ]);
      setAllSecurities(data);
      setTransactionSecurityIds(new Set(usedIds));

      // Aggregate holdings by securityId, filtering out negligible quantities
      const holdingsMap: SecurityHoldings = {};
      holdingsData.forEach((h: Holding) => {
        const currentQty = holdingsMap[h.securityId] || 0;
        // Convert quantity to number in case it's returned as a string from the API
        const quantity = typeof h.quantity === 'string' ? parseFloat(h.quantity) : h.quantity;
        const newQty = currentQty + quantity;
        // Only include if quantity is meaningful (not just rounding errors)
        if (Math.abs(newQty) > 0.00000001) {
          holdingsMap[h.securityId] = newQty;
        } else {
          // Remove if it rounds to zero
          delete holdingsMap[h.securityId];
        }
      });

      setHoldings(holdingsMap);
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useOnUndoRedo(loadData);

  // Apply status filter
  const statusFilteredSecurities = useMemo(() => {
    if (statusFilter === 'all') return allSecurities;
    return allSecurities.filter(s => statusFilter === 'active' ? s.isActive : !s.isActive);
  }, [allSecurities, statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreateNew = () => {
    openCreate();
  };

  const handleEdit = (security: Security) => {
    openEdit(security);
  };

  const handleFormSubmit = async (data: CreateSecurityData) => {
    try {
      if (editingSecurity) {
        await investmentsApi.updateSecurity(editingSecurity.id, data);
        toast.success(t('page.toasts.updated'));
      } else {
        await investmentsApi.createSecurity(data);
        toast.success(t('page.toasts.created'));
      }
      close();
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, editingSecurity ? t('page.toasts.updateFailed') : t('page.toasts.createFailed')));
      throw error;
    }
  };


  const handleDeleteClick = (security: Security) => {
    setDeleteConfirm({ isOpen: true, security });
  };

  const handleDeleteConfirm = async () => {
    const security = deleteConfirm.security;
    if (!security) return;
    setDeleteConfirm({ isOpen: false, security: null });
    try {
      await investmentsApi.deleteSecurity(security.id);
      toast.success(t('page.toasts.deleted', { symbol: security.symbol }));
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.deleteFailed')));
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirm({ isOpen: false, security: null });
  };

  const handleToggleFavourite = async (security: Security) => {
    const newValue = !security.isFavourite;
    // Optimistic, in-place update so the star flips instantly without a reload.
    setAllSecurities((prev) =>
      prev.map((s) => (s.id === security.id ? { ...s, isFavourite: newValue } : s)),
    );
    try {
      await investmentsApi.setSecurityFavourite(security.id, newValue);
    } catch (error) {
      // Revert on failure.
      setAllSecurities((prev) =>
        prev.map((s) => (s.id === security.id ? { ...s, isFavourite: !newValue } : s)),
      );
      toast.error(getErrorMessage(error, t('page.toasts.favouriteFailed')));
    }
  };

  const handleToggleActive = async (security: Security) => {
    try {
      if (security.isActive) {
        await investmentsApi.deactivateSecurity(security.id);
        toast.success(t('page.toasts.deactivated'));
      } else {
        await investmentsApi.activateSecurity(security.id);
        toast.success(t('page.toasts.activated'));
      }
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.statusFailed')));
    }
  };

  // Filter securities by search query
  const filteredSecurities = useMemo(() => {
    if (!searchQuery) return statusFilteredSecurities;
    return statusFilteredSecurities.filter(
      (s) =>
        s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [statusFilteredSecurities, searchQuery]);

  // Sort
  const sortedSecurities = useMemo(() => {
    return [...filteredSecurities].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'symbol') {
        comparison = a.symbol.localeCompare(b.symbol, undefined, { sensitivity: 'base' });
      } else if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'type') {
        comparison = (a.securityType || '').localeCompare(b.securityType || '', undefined, { sensitivity: 'base' });
      } else if (sortField === 'shares') {
        comparison = (holdings[a.id] || 0) - (holdings[b.id] || 0);
      } else if (sortField === 'exchange') {
        comparison = (a.exchange || '').localeCompare(b.exchange || '', undefined, { sensitivity: 'base' });
      } else if (sortField === 'currency') {
        comparison = a.currencyCode.localeCompare(b.currencyCode, undefined, { sensitivity: 'base' });
      } else if (sortField === 'provider') {
        comparison = (a.quoteProvider || '').localeCompare(b.quoteProvider || '', undefined, { sensitivity: 'base' });
      } else if (sortField === 'source') {
        comparison = (a.lastPriceSource || '').localeCompare(b.lastPriceSource || '', undefined, { sensitivity: 'base' });
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredSecurities, sortField, sortDirection, holdings]);

  // Pagination logic
  const totalPages = Math.ceil(sortedSecurities.length / PAGE_SIZE);
  const paginatedSecurities = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sortedSecurities.slice(start, start + PAGE_SIZE);
  }, [sortedSecurities, currentPage]);

  // Reset to page 1 when search or filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  const handleSort = useCallback((field: SecuritySortField) => {
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

  const activeCount = allSecurities.filter((s) => s.isActive).length;
  const inactiveCount = allSecurities.filter((s) => !s.isActive).length;

  const distinctTypes = useMemo(() => new Set(allSecurities.map(s => s.securityType).filter(Boolean)).size, [allSecurities]);
  const distinctExchanges = useMemo(() => new Set(allSecurities.map(s => s.exchange).filter(Boolean)).size, [allSecurities]);
  const distinctCurrencies = useMemo(() => new Set(allSecurities.map(s => s.currencyCode).filter(Boolean)).size, [allSecurities]);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/Investments"
          actions={<Button onClick={handleCreateNew}>{t('page.newSecurity')}</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard label={t('summary.totalSecurities')} value={allSecurities.length} icon={SummaryIcons.barChart} />
          <SummaryCard label={t('summary.types')} value={distinctTypes} icon={SummaryIcons.tag} />
          <SummaryCard label={t('summary.exchanges')} value={distinctExchanges} icon={SummaryIcons.list} />
          <SummaryCard label={t('summary.currencies')} value={distinctCurrencies} icon={SummaryIcons.money} />
        </div>

        {/* Search and Status Filter */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
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
                {status === 'active' ? t('page.statusActive', { count: activeCount }) :
                 status === 'inactive' ? t('page.statusInactive', { count: inactiveCount }) :
                 t('page.statusAll', { count: allSecurities.length })}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="2xl" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
          </h2>
          <SecurityForm
            security={editingSecurity}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Price History Modal */}
        <Modal isOpen={!!priceSecurity} onClose={() => setPriceSecurity(undefined)} maxWidth="5xl" className="p-6" pushHistory>
          {priceSecurity && (
            <SecurityPriceHistory
              security={priceSecurity}
              onClose={() => setPriceSecurity(undefined)}
            />
          )}
        </Modal>

        {/* Transaction History Modal */}
        <Modal isOpen={!!historySecurity} onClose={() => setHistorySecurity(undefined)} maxWidth="5xl" className="p-6" pushHistory>
          {historySecurity && (
            <SecurityTransactionHistory
              security={historySecurity}
              onClose={() => setHistorySecurity(undefined)}
              onChanged={loadData}
            />
          )}
        </Modal>

        {/* Securities List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <SecurityList
              securities={paginatedSecurities}
              holdings={holdings}
              transactionSecurityIds={transactionSecurityIds}
              onEdit={handleEdit}
              onToggleActive={handleToggleActive}
              onToggleFavourite={handleToggleFavourite}
              onDelete={handleDeleteClick}
              onViewPrices={setPriceSecurity}
              onViewHistory={setHistorySecurity}
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
              totalItems={sortedSecurities.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="securities"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {totalPages <= 1 && sortedSecurities.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('page.count', { count: sortedSecurities.length })}
          </div>
        )}

        {/* Delete Confirmation */}
        <ConfirmDialog
          isOpen={deleteConfirm.isOpen}
          title={t('page.deleteConfirm.title')}
          message={t('page.deleteConfirm.message', { symbol: deleteConfirm.security?.symbol || '' })}
          confirmLabel={t('page.deleteConfirm.confirmLabel')}
          cancelLabel={t('page.deleteConfirm.cancelLabel')}
          variant="danger"
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      </main>
    </PageLayout>
  );
}
