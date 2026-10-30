'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CARD_CLASS } from '@/components/ui/Card';
import { SecurityList, type SecurityHoldings, type SecurityTransactions, type SecuritySortField, type SortDirection } from '@/components/securities/SecurityList';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { BondRefreshProgress } from '@/components/securities/BondRefreshProgress';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { RefreshPricesButton } from '@/components/investments/RefreshPricesButton';
import { securityPositionValue, compareSecurityValues } from '@/lib/security-value';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { PAGE_SIZE } from '@/lib/constants';
import { useHighlightParam } from '@/hooks/useHighlightTarget';
import { useSearchParams } from 'next/navigation';
import { docsUrl } from '@/lib/docs-links';

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
  const router = useRouter();
  const [allSecurities, setAllSecurities] = useState<Security[]>([]);
  const [holdings, setHoldings] = useState<SecurityHoldings>({});
  const [transactionSecurityIds, setTransactionSecurityIds] = useState<SecurityTransactions>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; security: Security | null }>({
    isOpen: false,
    security: null,
  });
  const { showForm, editingItem: editingSecurity, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Security>();
  // Legacy deep link: `?price=<securityId>` used to open a price-history modal
  // on this page. The detail page owns that view now, so the link is honoured by
  // redirecting rather than broken -- old bookmarks and any link already sent out
  // keep working.
  const priceParamId = useSearchParams().get('price');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useLocalStorage<SecuritySortField>('monize-securities-sort-field', 'symbol');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-securities-sort-dir', 'asc');
  const [lastPriceUpdate, setLastPriceUpdate] = useState<string | null>(null);
  // The program whose post-save refresh is running; null hides the progress bar.
  const [bondRefreshProgramId, setBondRefreshProgramId] = useState<string | null>(null);

  // The mount load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
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
    };
    return run();
  }, [t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    return fetchData();
  }, [fetchData]);

  const loadPriceStatus = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const status = await investmentsApi.getPriceStatus();
        setLastPriceUpdate(status.lastUpdated);
      } catch (error) {
        // The age of the last refresh is decoration beside the list; failing to
        // read it must not take the page's own error handling with it.
        logger.error(error);
      }
    };
    return run();
  }, []);

  // The same control the Investments page carries, doing the same work through
  // the same hook: refresh every eligible security's quote, then reload. The
  // Value column beside each row is `shares * lastPrice`, so a refresh that did
  // not re-read the securities would leave the new prices off the screen that
  // asked for them.
  const { isRefreshing: isRefreshingPrices, triggerManualRefresh } = usePriceRefresh({
    onRefreshComplete: (lastUpdated) => {
      loadData();
      // Prefer the refresh result's own timestamp: a same-day refresh UPDATEs
      // the price row in place, so the DB-backed `createdAt` would not advance.
      if (lastUpdated) {
        setLastPriceUpdate(lastUpdated);
      } else {
        loadPriceStatus();
      }
    },
  });

  const handleRefreshPrices = useCallback(() => {
    void triggerManualRefresh();
  }, [triggerManualRefresh]);

  // Legacy `?price=<id>` links land on the detail page's Price history tab.
  useEffect(() => {
    if (priceParamId) router.replace(`/securities/${priceParamId}?tab=prices`);
  }, [priceParamId, router]);

  useOnUndoRedo(loadData);
  // Refresh after the AI assistant creates or edits a security from the chat.
  useOnAiAction(loadData);

  // Apply status filter
  const statusFilteredSecurities = useMemo(() => {
    if (statusFilter === 'all') return allSecurities;
    return allSecurities.filter(s => statusFilter === 'active' ? s.isActive : !s.isActive);
  }, [allSecurities, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    loadPriceStatus();
  }, [loadPriceStatus]);

  const handleCreateNew = () => {
    openCreate();
  };

  const handleEdit = (security: Security) => {
    openEdit(security);
  };

  // The detail page owns every view of a security, and is the linkable place
  // other screens point at.
  const handleOpen = useCallback(
    (security: Security) => {
      router.push(`/securities/${security.id}`);
    },
    [router],
  );

  const handleFormSubmit = async (data: CreateSecurityData) => {
    try {
      // A linked bond with auto-fetch on gets its data through the list's own
      // Refresh: the server fetches the program's current offer, then recomputes.
      let refreshId: string | null = null;
      let refreshProgramId: string | null = null;
      if (editingSecurity) {
        await investmentsApi.updateSecurity(editingSecurity.id, data);
        toast.success(t('page.toasts.updated'));
        // The form omits link fields that did not change, so an absent field
        // keeps the stored value; only a present, different program is a change.
        const programId = data.bondProgramId !== undefined ? data.bondProgramId : editingSecurity.bondProgramId;
        const autoFetch = data.bondAutoFetch !== undefined ? data.bondAutoFetch : editingSecurity.bondAutoFetch;
        const wasOn = !!editingSecurity.bondProgramId && editingSecurity.bondAutoFetch === true;
        const isOn = !!programId && autoFetch === true;
        const programChanged = data.bondProgramId !== undefined && data.bondProgramId !== editingSecurity.bondProgramId;
        if (isOn && (!wasOn || programChanged)) {
          refreshId = editingSecurity.id;
          refreshProgramId = programId ?? null;
        }
      } else {
        const created = await investmentsApi.createSecurity(data);
        toast.success(t('page.toasts.created'));
        if (data.bondProgramId && data.bondAutoFetch === true) {
          refreshId = created.id;
          refreshProgramId = data.bondProgramId;
        }
      }
      close();
      loadData();
      if (refreshId && refreshProgramId) {
        setBondRefreshProgramId(refreshProgramId);
        void triggerManualRefresh([refreshId]).finally(() => setBondRefreshProgramId(null));
      } else if (refreshId) {
        void triggerManualRefresh([refreshId]);
      }
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
      // Value is the one field whose unknowns must not sort as small numbers,
      // so it answers before the direction is applied rather than after.
      if (sortField === 'value') {
        return compareSecurityValues(
          securityPositionValue(holdings[a.id] || 0, a.lastPrice),
          securityPositionValue(holdings[b.id] || 0, b.lastPrice),
          sortDirection,
        );
      }
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
  const handleSearchChange = (query: string) => {
    if (query !== searchQuery) setCurrentPage(1);
    setSearchQuery(query);
  };

  const handleStatusFilterChange = (status: 'all' | 'active' | 'inactive') => {
    if (status !== statusFilter) setCurrentPage(1);
    setStatusFilter(status);
  };

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

  // Deep link to a specific security (e.g. the AI chat "View securities" link):
  // jump to the client-side page that contains it once the list has loaded, so
  // the row can flash and scroll into view. Runs once per arrival, during render
  // rather than in an effect.
  const highlightId = useHighlightParam();
  const [highlightJumped, setHighlightJumped] = useState(false);
  if (highlightId && !highlightJumped && sortedSecurities.length > 0) {
    const index = sortedSecurities.findIndex((s) => s.id === highlightId);
    if (index >= 0) {
      setHighlightJumped(true);
      setCurrentPage(Math.floor(index / PAGE_SIZE) + 1);
    }
  }

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
          helpUrl={docsUrl('securities')}
          actions={
            <>
              <RefreshPricesButton
                onClick={handleRefreshPrices}
                isRefreshing={isRefreshingPrices}
                lastPriceUpdate={lastPriceUpdate}
              />
              <Button onClick={handleCreateNew}>{t('page.newSecurity')}</Button>
            </>
          }
        />
        <BondRefreshProgress
          programId={bondRefreshProgramId}
          active={bondRefreshProgramId !== null}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard label={t('summary.totalSecurities')} value={allSecurities.length} icon={SummaryIcons.barChart} />
          <SummaryCard label={t('summary.types')} value={distinctTypes} icon={SummaryIcons.tag} />
          <SummaryCard label={t('summary.exchanges')} value={distinctExchanges} icon={SummaryIcons.list} />
          <SummaryCard label={t('summary.currencies')} value={distinctCurrencies} icon={SummaryIcons.money} />
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
                 t('page.statusAll', { count: allSecurities.length })}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="3xl"
          className="p-6"
          title={isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
        >
          <SecurityForm
            security={editingSecurity}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Securities List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
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
              onOpen={handleOpen}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              highlightId={highlightId}
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
