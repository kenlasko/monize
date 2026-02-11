'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { PayeeForm } from '@/components/payees/PayeeForm';
import { PayeeList, DensityLevel, SortField, SortDirection } from '@/components/payees/PayeeList';
import { CategoryAutoAssignDialog } from '@/components/payees/CategoryAutoAssignDialog';
import { Modal } from '@/components/ui/Modal';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { Payee } from '@/types/payee';
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

const logger = createLogger('Payees');

const PAGE_SIZE = 50;

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
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-payees-density', 'normal');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const { showForm, editingItem, openCreate, openEdit, close, isEditing } = useFormModal<Payee>();

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [payeesData, categoriesData] = await Promise.all([
        payeesApi.getAll(),
        categoriesApi.getAll(),
      ]);
      setPayees(payeesData);
      setCategories(categoriesData);
    } catch (error) {
      toast.error('Failed to load data');
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
      const cleanedData = {
        ...data,
        defaultCategoryId: data.defaultCategoryId || undefined,
        notes: data.notes || undefined,
      };

      if (editingItem) {
        await payeesApi.update(editingItem.id, cleanedData);
        toast.success('Payee updated successfully');
      } else {
        await payeesApi.create(cleanedData);
        toast.success('Payee created successfully');
      }
      close();
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingItem ? 'update' : 'create'} payee`));
      throw error;
    }
  };

  const filteredPayees = useMemo(() => {
    if (!searchQuery) return payees;
    return payees.filter((p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [payees, searchQuery]);

  const sortedPayees = useMemo(() => {
    return [...filteredPayees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'category') {
        const catA = a.defaultCategory?.name || '';
        const catB = b.defaultCategory?.name || '';
        comparison = catA.localeCompare(catB);
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
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
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
    setCurrentPage(1);
  }, [sortField]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const payeesWithCategory = payees.filter((p) => p.defaultCategoryId).length;
  const payeesWithoutCategory = payees.length - payeesWithCategory;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader
          title="Payees"
          subtitle="Manage your payees and their default categories"
          actions={
            <>
              <Button variant="secondary" onClick={() => setShowAutoAssign(true)}>
                Auto-Assign Categories
              </Button>
              <Button onClick={openCreate}>+ New Payee</Button>
            </>
          }
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard
            label="Total Payees"
            value={payees.length}
            icon={SummaryIcons.users}
          />
          <SummaryCard
            label="With Category"
            value={payeesWithCategory}
            icon={SummaryIcons.checkCircle}
            valueColor="green"
          />
          <SummaryCard
            label="Without Category"
            value={payeesWithoutCategory}
            icon={SummaryIcons.warning}
            valueColor="yellow"
          />
        </div>

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Search payees..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Payee' : 'New Payee'}
          </h2>
          <PayeeForm
            payee={editingItem}
            categories={categories}
            onSubmit={handleFormSubmit}
            onCancel={close}
          />
        </Modal>

        {/* Payees List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading payees..." />
          ) : (
            <PayeeList
              payees={paginatedPayees}
              onEdit={openEdit}
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
    </PageLayout>
  );
}
