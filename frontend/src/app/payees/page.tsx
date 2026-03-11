'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { PayeeForm } from '@/components/payees/PayeeForm';
import { PayeeList, type DensityLevel, type SortField, type SortDirection } from '@/components/payees/PayeeList';
import { CategoryAutoAssignDialog } from '@/components/payees/CategoryAutoAssignDialog';
import { DeactivateUnusedPayeesDialog } from '@/components/payees/DeactivateUnusedPayeesDialog';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { buildCategoryColorMap } from '@/lib/categoryUtils';
import { MergePayeeDialog } from '@/components/payees/MergePayeeDialog';
import { Payee, PayeeStatusFilter } from '@/types/payee';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { PAGE_SIZE } from '@/lib/constants';

const logger = createLogger('Payees');

export default function PayeesPage() {
  return (
    <ProtectedRoute>
      <PayeesContent />
    </ProtectedRoute>
  );
}

function PayeesContent() {
  const [payees, setPayees] = useState<Payee[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAutoAssign, setShowAutoAssign] = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PayeeStatusFilter>('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-payees-density', 'normal');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [mergePayee, setMergePayee] = useState<Payee | null>(null);
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Payee>();

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [payeesData, categoriesData] = await Promise.all([
        payeesApi.getAll('all'),
        categoriesApi.getAll(),
      ]);
      setPayees(payeesData);
      setCategories(categoriesData);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load data'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

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
        toast.success('Payee updated successfully');
        close();
        setPayees(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
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

        toast.success('Payee created successfully');
        close();
        setPayees(prev => [{ ...created, aliasCount }, ...prev]);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingItem ? 'update' : 'create'} payee`));
      throw error;
    }
  };

  const handleReactivate = async (payeeId: string) => {
    try {
      const reactivated = await payeesApi.reactivatePayee(payeeId);
      toast.success(`Payee "${reactivated.name}" reactivated`);
      setPayees(prev => prev.map(p => p.id === reactivated.id ? reactivated : p));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to reactivate payee'));
      logger.error(error);
    }
  };

  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);

  // Apply status filter
  const statusFilteredPayees = useMemo(() => {
    if (statusFilter === 'all') return payees;
    return payees.filter(p => statusFilter === 'active' ? p.isActive : !p.isActive);
  }, [payees, statusFilter]);

  const filteredPayees = useMemo(() => {
    if (!searchQuery) return statusFilteredPayees;
    return statusFilteredPayees.filter((p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [statusFilteredPayees, searchQuery]);

  const sortedPayees = useMemo(() => {
    return [...filteredPayees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'category') {
        const catA = a.defaultCategory?.name || '';
        const catB = b.defaultCategory?.name || '';
        comparison = catA.localeCompare(catB, undefined, { sensitivity: 'base' });
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      } else if (sortField === 'aliases') {
        comparison = (a.aliasCount ?? 0) - (b.aliasCount ?? 0);
      } else if (sortField === 'createdAt') {
        comparison = (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredPayees, sortField, sortDirection]);

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
      setSortDirection(field === 'count' || field === 'aliases' || field === 'createdAt' ? 'desc' : 'asc');
    }
    setCurrentPage(1);
  }, [sortField]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  // Summary counts
  const activeCount = payees.filter(p => p.isActive).length;
  const inactiveCount = payees.filter(p => !p.isActive).length;
  const payeesWithCategory = payees.filter((p) => p.defaultCategoryId).length;
  const payeesWithoutCategory = payees.length - payeesWithCategory;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Payees"
          subtitle="Manage your payees and their default categories"
          helpUrl="https://github.com/kenlasko/monize/wiki/Categories-and-Payees"
          actions={
            <>
              <Button variant="secondary" onClick={() => setShowDeactivate(true)}>
                Deactivate Unused
              </Button>
              <Button variant="secondary" onClick={() => setShowAutoAssign(true)}>
                Auto-Assign Categories
              </Button>
              <Button onClick={openCreate}>+ New Payee</Button>
            </>
          }
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <SummaryCard
            label="Total Payees"
            value={payees.length}
            icon={SummaryIcons.users}
          />
          <SummaryCard
            label="Active"
            value={activeCount}
            icon={SummaryIcons.checkCircle}
            valueColor="green"
          />
          <SummaryCard
            label="Inactive"
            value={inactiveCount}
            icon={SummaryIcons.warning}
            valueColor={inactiveCount > 0 ? 'yellow' : undefined}
          />
          <SummaryCard
            label="Without Category"
            value={payeesWithoutCategory}
            icon={SummaryIcons.warning}
            valueColor={payeesWithoutCategory > 0 ? 'yellow' : undefined}
          />
        </div>

        {/* Search and Status Filter */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search payees..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
          <div className="flex rounded-md shadow-sm">
            {(['all', 'active', 'inactive'] as PayeeStatusFilter[]).map((status) => (
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
                 `All (${payees.length})`}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Payee' : 'New Payee'}
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
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading payees..." />
          ) : (
            <PayeeList
              payees={paginatedPayees}
              onEdit={openEdit}
              onRefresh={loadData}
              onDelete={(deletedId) => setPayees(prev => prev.filter(p => p.id !== deletedId))}
              onReactivate={handleReactivate}
              onMerge={setMergePayee}
              showStatusColumn={statusFilter === 'all' || statusFilter === 'inactive'}
              density={listDensity}
              onDensityChange={setListDensity}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              categoryColorMap={categoryColorMap}
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
            {sortedPayees.length} payee{sortedPayees.length !== 1 ? 's' : ''}
          </div>
        )}
      </main>

      {/* Auto-Assign Categories Dialog */}
      <CategoryAutoAssignDialog
        isOpen={showAutoAssign}
        onClose={() => setShowAutoAssign(false)}
        onSuccess={loadData}
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
    </PageLayout>
  );
}
