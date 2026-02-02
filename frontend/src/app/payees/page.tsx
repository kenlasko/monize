'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { PayeeForm } from '@/components/payees/PayeeForm';
import { PayeeList, DensityLevel, SortField, SortDirection } from '@/components/payees/PayeeList';
import { CategoryAutoAssignDialog } from '@/components/payees/CategoryAutoAssignDialog';
import { AppHeader } from '@/components/layout/AppHeader';
import { Modal } from '@/components/ui/Modal';
import { payeesApi } from '@/lib/payees';
import { categoriesApi } from '@/lib/categories';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';

const PAGE_SIZE = 50;

export default function PayeesPage() {
  const [payees, setPayees] = useState<Payee[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPayee, setEditingPayee] = useState<Payee | undefined>();
  const [showAutoAssign, setShowAutoAssign] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('moneymate-payees-density', 'normal');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

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
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateNew = () => {
    setEditingPayee(undefined);
    setShowForm(true);
  };

  const handleEdit = (payee: Payee) => {
    setEditingPayee(payee);
    setShowForm(true);
  };

  const handleFormSubmit = async (data: any) => {
    try {
      // Clean up empty strings
      const cleanedData = {
        ...data,
        defaultCategoryId: data.defaultCategoryId || undefined,
        notes: data.notes || undefined,
      };

      if (editingPayee) {
        await payeesApi.update(editingPayee.id, cleanedData);
        toast.success('Payee updated successfully');
      } else {
        await payeesApi.create(cleanedData);
        toast.success('Payee created successfully');
      }
      setShowForm(false);
      setEditingPayee(undefined);
      loadData();
    } catch (error: any) {
      const message =
        error.response?.data?.message || `Failed to ${editingPayee ? 'update' : 'create'} payee`;
      toast.error(message);
      throw error;
    }
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingPayee(undefined);
  };

  // Filter payees by search query
  const filteredPayees = useMemo(() => {
    if (!searchQuery) return payees;
    return payees.filter((p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [payees, searchQuery]);

  // Sort filtered payees
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

  // Pagination logic
  const totalPages = Math.ceil(sortedPayees.length / PAGE_SIZE);
  const paginatedPayees = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sortedPayees.slice(start, start + PAGE_SIZE);
  }, [sortedPayees, currentPage]);

  // Handle sort change from PayeeList
  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
    setCurrentPage(1); // Reset to first page when sorting changes
  }, [sortField]);

  // Reset to page 1 when search changes
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
        <div className="px-4 sm:px-6 lg:px-12 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Payees</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage your payees and their default categories
              </p>
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setShowAutoAssign(true)}>
                Auto-Assign Categories
              </Button>
              <Button onClick={handleCreateNew}>+ New Payee</Button>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-gray-400 dark:text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Total Payees</dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">{payees.length}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-green-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">With Category</dt>
                    <dd className="text-lg font-semibold text-green-600 dark:text-green-400">{payeesWithCategory}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 overflow-hidden shadow dark:shadow-gray-700/50 rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg
                    className="h-6 w-6 text-yellow-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">Without Category</dt>
                    <dd className="text-lg font-semibold text-yellow-600 dark:text-yellow-400">{payeesWithoutCategory}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
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
        <Modal isOpen={showForm} onClose={handleFormCancel} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingPayee ? 'Edit Payee' : 'New Payee'}
          </h2>
          <PayeeForm
            payee={editingPayee}
            categories={categories}
            onSubmit={handleFormSubmit}
            onCancel={handleFormCancel}
          />
        </Modal>

        {/* Payees List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
              <p className="mt-2 text-gray-500 dark:text-gray-400">Loading payees...</p>
            </div>
          ) : (
            <PayeeList
              payees={paginatedPayees}
              onEdit={handleEdit}
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
      </div>

      {/* Auto-Assign Categories Dialog */}
      <CategoryAutoAssignDialog
        isOpen={showAutoAssign}
        onClose={() => setShowAutoAssign(false)}
        onSuccess={loadData}
      />
    </div>
  );
}
