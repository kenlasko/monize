'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { Button } from '@/components/ui/Button';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Pagination } from '@/components/ui/Pagination';
import { PayeeForm } from '@/components/payees/PayeeForm';
import { PayeeList, type SortField, type SortDirection } from '@/components/payees/PayeeList';
import { CategoryAutoAssignDialog } from '@/components/payees/CategoryAutoAssignDialog';
import { DeactivateUnusedPayeesDialog } from '@/components/payees/DeactivateUnusedPayeesDialog';
import { AutoMergePayeesDialog } from '@/components/payees/AutoMergePayeesDialog';
import { Modal } from '@/components/ui/Modal';
import { PayeeLookupSection } from '@/components/settings/payee-lookup/PayeeLookupSection';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { buildCategoryColorMap, buildCategoryIconMap, buildCategoryLabelMap } from '@/lib/categoryUtils';
import { MergePayeeDialog } from '@/components/payees/MergePayeeDialog';
import { Payee, PayeeStatusFilter, PayeeCategoryFilter } from '@/types/payee';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CARD_CLASS } from '@/components/ui/Card';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { PAGE_SIZE } from '@/lib/constants';
import { useHighlightParam } from '@/hooks/useHighlightTarget';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Payees');

export default function PayeesPage() {
  return (
    <ProtectedRoute>
      <PayeesContent />
    </ProtectedRoute>
  );
}

function PayeesContent() {
  const t = useTranslations('payees');
  // The dialog's title is the section's own name, so the two cannot drift.
  const tLookup = useTranslations('settings.payeeLookup');
  const tCommon = useTranslations('common');
  const [payees, setPayees] = useState<Payee[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAutoAssign, setShowAutoAssign] = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [showAutoMerge, setShowAutoMerge] = useState(false);
  const [showApplyDefaults, setShowApplyDefaults] = useState(false);
  const [showLookupSettings, setShowLookupSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PayeeStatusFilter>('active');
  const [categoryFilter, setCategoryFilter] = useState<PayeeCategoryFilter>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useLocalStorage<SortField>('monize-payees-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-payees-sort-dir', 'asc');
  const [mergePayee, setMergePayee] = useState<Payee | null>(null);
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Payee>();

  // The mount load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const [payeesData, categoriesData] = await Promise.all([
          payeesApi.getAll('all'),
          categoriesApi.getAll(),
        ]);
        setPayees(payeesData);
        setCategories(categoriesData);
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

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useOnUndoRedo(loadData);
  // Refresh after the AI assistant creates or edits a payee from the chat.
  useOnAiAction(loadData);

  const handleFormSubmit = async (data: any) => {
    try {
      const { pendingAliases, ...formData } = data;
      const cleanedData = {
        ...formData,
        defaultCategoryId: formData.defaultCategoryId === '' || formData.defaultCategoryId === undefined
          ? null
          : formData.defaultCategoryId,
        notes: formData.notes || undefined,
      };

      if (editingItem) {
        const updated = await payeesApi.update(editingItem.id, cleanedData);
        toast.success(t('page.toasts.updated'));
        const categorized = updated.transactionsCategorized ?? 0;
        if (categorized > 0) {
          toast.success(t('page.toasts.categorized', { count: categorized }));
        }
        close();
        if (categorized > 0) {
          // The backfill changed transaction categories, so derived per-payee
          // counts (uncategorized, etc.) are stale -- reload rather than merge.
          loadData();
        } else {
          setPayees(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
        }
      } else {
        const created = await payeesApi.create(cleanedData);

        // Create any aliases that were added during payee creation
        let aliasCount = 0;
        if (pendingAliases && pendingAliases.length > 0) {
          for (const alias of pendingAliases) {
            await payeesApi.createAlias({ payeeId: created.id, alias });
            aliasCount++;
          }
        }

        toast.success(t('page.toasts.created'));
        close();
        setPayees(prev => [{ ...created, aliasCount }, ...prev]);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, editingItem ? t('page.toasts.updateFailed') : t('page.toasts.createFailed')));
      throw error;
    }
  };

  const handleReactivate = async (payeeId: string) => {
    try {
      const reactivated = await payeesApi.reactivatePayee(payeeId);
      toast.success(t('page.toasts.reactivated', { name: reactivated.name }));
      setPayees(prev => prev.map(p => p.id === reactivated.id ? reactivated : p));
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.reactivateFailed')));
      logger.error(error);
    }
  };

  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap(categories), [categories]);
  const categoryLabelMap = useMemo(() => buildCategoryLabelMap(categories), [categories]);

  // Payees that have a default category set but still have uncategorized
  // transactions -- the scope of the bulk "apply default categories" action.
  const backfillTargets = useMemo(
    () => payees.filter((p) => p.defaultCategoryId && (p.uncategorizedCount ?? 0) > 0),
    [payees],
  );
  const backfillTotals = useMemo(
    () => ({
      payees: backfillTargets.length,
      transactions: backfillTargets.reduce((sum, p) => sum + (p.uncategorizedCount ?? 0), 0),
    }),
    [backfillTargets],
  );

  // Apply each payee's existing default category to its uncategorized
  // transactions, reusing the category-suggestions apply endpoint (which sets
  // the default category -- a no-op here -- and backfills when asked).
  const handleApplyDefaultCategories = async () => {
    setShowApplyDefaults(false);
    if (backfillTargets.length === 0) {
      toast(t('defaultCategoryBackfill.toasts.nothingToDo'));
      return;
    }
    try {
      const assignments = backfillTargets.map((p) => ({
        payeeId: p.id,
        categoryId: p.defaultCategoryId as string,
        backfillTransactions: true,
      }));
      const result = await payeesApi.applyCategorySuggestions(assignments);
      toast.success(t('defaultCategoryBackfill.toasts.applied', { count: result.transactionsBackfilled }));
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, t('defaultCategoryBackfill.toasts.failed')));
      logger.error(error);
    }
  };

  // Apply status filter
  const statusFilteredPayees = useMemo(() => {
    if (statusFilter === 'all') return payees;
    return payees.filter(p => statusFilter === 'active' ? p.isActive : !p.isActive);
  }, [payees, statusFilter]);

  // Apply category filter: payees missing a default category, or payees that
  // still have transactions with no category at all.
  const categoryFilteredPayees = useMemo(() => {
    if (categoryFilter === 'noDefaultCategory') {
      return statusFilteredPayees.filter(p => !p.defaultCategoryId);
    }
    if (categoryFilter === 'uncategorizedTransactions') {
      return statusFilteredPayees.filter(p => (p.uncategorizedCount ?? 0) > 0);
    }
    return statusFilteredPayees;
  }, [statusFilteredPayees, categoryFilter]);

  const filteredPayees = useMemo(() => {
    if (!searchQuery) return categoryFilteredPayees;
    return categoryFilteredPayees.filter((p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [categoryFilteredPayees, searchQuery]);

  const sortedPayees = useMemo(() => {
    return [...filteredPayees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'category') {
        const catA = a.defaultCategory ? (categoryLabelMap.get(a.defaultCategory.id) ?? a.defaultCategory.name) : '';
        const catB = b.defaultCategory ? (categoryLabelMap.get(b.defaultCategory.id) ?? b.defaultCategory.name) : '';
        comparison = catA.localeCompare(catB, undefined, { sensitivity: 'base' });
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      } else if (sortField === 'aliases') {
        comparison = (a.aliasCount ?? 0) - (b.aliasCount ?? 0);
      } else if (sortField === 'lastUsed') {
        comparison = (a.lastUsedDate || '').localeCompare(b.lastUsedDate || '');
      } else if (sortField === 'createdAt') {
        comparison = (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredPayees, sortField, sortDirection, categoryLabelMap]);

  const totalPages = Math.ceil(sortedPayees.length / PAGE_SIZE);
  const paginatedPayees = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sortedPayees.slice(start, start + PAGE_SIZE);
  }, [sortedPayees, currentPage]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' || field === 'aliases' || field === 'lastUsed' || field === 'createdAt' ? 'desc' : 'asc');
    }
    setCurrentPage(1);
  }, [sortField, setSortField, setSortDirection]);

  // A new search or filter starts again from the first page.
  const handleSearchChange = (query: string) => {
    if (query !== searchQuery) setCurrentPage(1);
    setSearchQuery(query);
  };

  const handleStatusFilterChange = (status: PayeeStatusFilter) => {
    if (status !== statusFilter) setCurrentPage(1);
    setStatusFilter(status);
  };

  const handleCategoryFilterChange = (filter: PayeeCategoryFilter) => {
    if (filter !== categoryFilter) setCurrentPage(1);
    setCategoryFilter(filter);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  // Deep link to a specific payee (e.g. the AI chat "View payees" link): once
  // the list has loaded, jump to the client-side page that contains it so the
  // row can flash and scroll into view. Runs once per arrival, during render
  // rather than in an effect.
  const highlightId = useHighlightParam();
  const [highlightJumped, setHighlightJumped] = useState(false);
  if (highlightId && !highlightJumped && sortedPayees.length > 0) {
    const index = sortedPayees.findIndex((p) => p.id === highlightId);
    if (index >= 0) {
      setHighlightJumped(true);
      setCurrentPage(Math.floor(index / PAGE_SIZE) + 1);
    }
  }

  // Summary counts
  const activeCount = payees.filter(p => p.isActive).length;
  const inactiveCount = payees.filter(p => !p.isActive).length;
  const payeesWithCategory = payees.filter((p) => p.defaultCategoryId).length;
  const payeesWithoutCategory = payees.length - payeesWithCategory;
  const payeesWithUncategorizedTx = payees.filter((p) => (p.uncategorizedCount ?? 0) > 0).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('payees')}
          actions={
            <>
              {/* The four bulk operations live behind one trigger: they are
                  occasional maintenance, while New Payee is the everyday
                  action. Five buttons in a header wrapped in every language and
                  stacked into five full-width bars on a phone. */}
              <ActionMenu
                label={t('page.maintenance')}
                items={[
                  {
                    id: 'autoMerge',
                    label: t('page.autoMergePayees'),
                    onSelect: () => setShowAutoMerge(true),
                  },
                  {
                    id: 'deactivateUnused',
                    label: t('page.deactivateUnused'),
                    onSelect: () => setShowDeactivate(true),
                  },
                  {
                    id: 'autoAssignCategories',
                    label: t('page.autoAssignCategories'),
                    onSelect: () => setShowAutoAssign(true),
                  },
                  {
                    id: 'applyDefaultCategories',
                    label: t('page.applyDefaultCategories'),
                    onSelect: () => setShowApplyDefaults(true),
                  },
                  {
                    // The same section Settings renders, reached from where
                    // payees are actually worked on. One component, so the two
                    // places cannot offer different controls.
                    id: 'lookupSettings',
                    label: t('page.lookupSettings'),
                    onSelect: () => setShowLookupSettings(true),
                  },
                ]}
              />
              <Button onClick={openCreate}>{t('page.newPayee')}</Button>
            </>
          }
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <SummaryCard
            label={t('page.summary.totalPayees')}
            value={payees.length}
            icon={SummaryIcons.users}
          />
          <SummaryCard
            label={t('page.summary.active')}
            value={activeCount}
            icon={SummaryIcons.checkCircle}
            valueColor="green"
          />
          <SummaryCard
            label={t('page.summary.inactive')}
            value={inactiveCount}
            icon={SummaryIcons.warning}
            valueColor={inactiveCount > 0 ? 'yellow' : undefined}
          />
          <SummaryCard
            label={t('page.summary.withoutCategory')}
            value={payeesWithoutCategory}
            icon={SummaryIcons.warning}
            valueColor={payeesWithoutCategory > 0 ? 'yellow' : undefined}
          />
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
            {(['all', 'active', 'inactive'] as PayeeStatusFilter[]).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => handleStatusFilterChange(status)}
                aria-pressed={statusFilter === status}
                className={toolbarSegmentClass(statusFilter === status)}
              >
                {status === 'active' ? t('page.statusActive', { count: activeCount }) :
                 status === 'inactive' ? t('page.statusInactive', { count: inactiveCount }) :
                 t('page.statusAll', { count: payees.length })}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t('page.categoryFilterLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
            {(['all', 'noDefaultCategory', 'uncategorizedTransactions'] as PayeeCategoryFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => handleCategoryFilterChange(filter)}
                aria-pressed={categoryFilter === filter}
                className={toolbarSegmentClass(categoryFilter === filter)}
              >
                {filter === 'noDefaultCategory' ? t('page.categoryFilterNoCategory', { count: payeesWithoutCategory }) :
                 filter === 'uncategorizedTransactions' ? t('page.categoryFilterUncategorized', { count: payeesWithUncategorizedTx }) :
                 t('page.categoryFilterAll', { count: payees.length })}
              </button>
            ))}
          </div>
        </div>

        {/* The Payee Lookup settings, rendered from the one section the
            Settings page uses. `padding="none"` lets the section's own Card be
            the panel rather than nesting a card inside a padded dialog. */}
        {/* Sized to the column the same section occupies on Settings, so the
            two places render one card rather than a wide one and a cramped
            one. That column is the settings page's max-w-6xl main less its
            lg:px-12, its lg:w-52 nav and the lg:gap-10 between them: 72 - 6 -
            13 - 2.5 = 50.5rem, and max-w-3xl (48rem) is the nearest size the
            modal offers. The next one up overshoots by 5.5rem and, with the
            backdrop's own padding, leaves a 1024px laptop almost no margin. */}
        <Modal
          isOpen={showLookupSettings}
          onClose={() => setShowLookupSettings(false)}
          title={tLookup('title')}
          maxWidth="3xl"
          padding="md"
          pushHistory
          footer={
            <Button type="button" variant="outline" onClick={() => setShowLookupSettings(false)}>
              {tCommon('close')}
            </Button>
          }
        >
          <PayeeLookupSection className="" />
        </Modal>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
          </h2>
          <PayeeForm
            payee={editingItem}
            categories={categories}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Payees List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <PayeeList
              payees={paginatedPayees}
              onEdit={openEdit}
              onRefresh={loadData}
              onDelete={(deletedId) => setPayees(prev => prev.filter(p => p.id !== deletedId))}
              onReactivate={handleReactivate}
              onMerge={setMergePayee}
              showStatusColumn={statusFilter === 'all' || statusFilter === 'inactive'}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              categoryColorMap={categoryColorMap}
              categoryIconMap={categoryIconMap}
              categoryLabelMap={categoryLabelMap}
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
              totalItems={sortedPayees.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="payees"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {totalPages <= 1 && sortedPayees.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('page.count', { count: sortedPayees.length })}
          </div>
        )}
      </main>

      {/* Auto-Assign Categories Dialog */}
      <CategoryAutoAssignDialog
        isOpen={showAutoAssign}
        onClose={() => setShowAutoAssign(false)}
        onSuccess={loadData}
        categories={categories}
      />

      {/* Merge Payee Dialog */}
      <MergePayeeDialog
        isOpen={mergePayee !== null}
        sourcePayee={mergePayee}
        allPayees={payees}
        onClose={() => setMergePayee(null)}
        onSuccess={loadData}
      />

      {/* Deactivate Unused Payees Dialog */}
      <DeactivateUnusedPayeesDialog
        isOpen={showDeactivate}
        onClose={() => setShowDeactivate(false)}
        onSuccess={loadData}
      />

      {/* Auto-Merge Payees Dialog */}
      <AutoMergePayeesDialog
        isOpen={showAutoMerge}
        onClose={() => setShowAutoMerge(false)}
        onSuccess={loadData}
        categories={categories}
      />

      {/* Apply default categories to all payees with uncategorized transactions */}
      <ConfirmDialog
        isOpen={showApplyDefaults}
        variant="info"
        title={t('defaultCategoryBackfill.allConfirmTitle')}
        message={t('defaultCategoryBackfill.allConfirmMessage', {
          transactions: backfillTotals.transactions,
          payees: backfillTotals.payees,
        })}
        confirmLabel={t('defaultCategoryBackfill.confirmButton')}
        onConfirm={handleApplyDefaultCategories}
        onCancel={() => setShowApplyDefaults(false)}
      />
    </PageLayout>
  );
}
