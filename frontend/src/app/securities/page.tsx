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
import { investmentsApi } from '@/lib/investments';
import { Security, CreateSecurityData } from '@/types/investment';
import { SecurityForm } from '@/components/securities/SecurityForm';
import { SecurityList, DensityLevel } from '@/components/securities/SecurityList';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Securities');

const PAGE_SIZE = 50;

export default function SecuritiesPage() {
  return (
    <ProtectedRoute>
      <SecuritiesContent />
    </ProtectedRoute>
  );
}

function SecuritiesContent() {
  const [securities, setSecurities] = useState<Security[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSecurity, setEditingSecurity] = useState<Security | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-securities-density', 'normal');

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await investmentsApi.getSecurities(showInactive);
      setSecurities(data);
    } catch (error) {
      toast.error('Failed to load securities');
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [showInactive]);

  const handleCreateNew = () => {
    setEditingSecurity(undefined);
    setShowForm(true);
  };

  const handleEdit = (security: Security) => {
    setEditingSecurity(security);
    setShowForm(true);
  };

  const handleFormSubmit = async (data: CreateSecurityData) => {
    try {
      if (editingSecurity) {
        await investmentsApi.updateSecurity(editingSecurity.id, data);
        toast.success('Security updated successfully');
      } else {
        await investmentsApi.createSecurity(data);
        toast.success('Security created successfully');
      }
      setShowForm(false);
      setEditingSecurity(undefined);
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingSecurity ? 'update' : 'create'} security`));
      throw error;
    }
  };

  const handleFormCancel = () => {
    setShowForm(false);
    setEditingSecurity(undefined);
  };

  const handleToggleActive = async (security: Security) => {
    try {
      if (security.isActive) {
        await investmentsApi.deactivateSecurity(security.id);
        toast.success('Security deactivated');
      } else {
        await investmentsApi.activateSecurity(security.id);
        toast.success('Security activated');
      }
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update security status'));
    }
  };

  // Filter securities by search query
  const filteredSecurities = useMemo(() => {
    if (!searchQuery) return securities;
    return securities.filter(
      (s) =>
        s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [securities, searchQuery]);

  // Pagination logic
  const totalPages = Math.ceil(filteredSecurities.length / PAGE_SIZE);
  const paginatedSecurities = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredSecurities.slice(start, start + PAGE_SIZE);
  }, [filteredSecurities, currentPage]);

  // Reset to page 1 when search or filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, showInactive]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const activeCount = securities.filter((s) => s.isActive).length;
  const inactiveCount = securities.filter((s) => !s.isActive).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader
          title="Securities"
          subtitle="Manage your stocks, ETFs, mutual funds, and other securities"
          actions={<Button onClick={handleCreateNew}>+ New Security</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard label="Total Securities" value={securities.length} icon={SummaryIcons.barChart} />
          <SummaryCard label="Active" value={activeCount} icon={SummaryIcons.checkCircle} valueColor="green" />
          <SummaryCard label="Inactive" value={inactiveCount} icon={SummaryIcons.ban} />
        </div>

        {/* Search and Filters */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search by symbol or name..."
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
            Show inactive securities
          </label>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleFormCancel} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {editingSecurity ? 'Edit Security' : 'New Security'}
          </h2>
          <SecurityForm
            security={editingSecurity}
            onSubmit={handleFormSubmit}
            onCancel={handleFormCancel}
          />
        </Modal>

        {/* Securities List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading securities..." />
          ) : (
            <SecurityList
              securities={paginatedSecurities}
              onEdit={handleEdit}
              onToggleActive={handleToggleActive}
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
              totalItems={filteredSecurities.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="securities"
            />
          </div>
        )}

        {/* Show total count when only one page */}
        {totalPages <= 1 && filteredSecurities.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {filteredSecurities.length} securit{filteredSecurities.length !== 1 ? 'ies' : 'y'}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
