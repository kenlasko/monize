'use client';

import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { AppHeader } from '@/components/layout/AppHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { investmentsApi } from '@/lib/investments';
import { Security, CreateSecurityData } from '@/types/investment';
import { SecurityForm } from '@/components/securities/SecurityForm';
import { SecurityList } from '@/components/securities/SecurityList';

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

  const loadData = async () => {
    setIsLoading(true);
    try {
      const data = await investmentsApi.getSecurities(showInactive);
      setSecurities(data);
    } catch (error) {
      toast.error('Failed to load securities');
      console.error(error);
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
    } catch (error: any) {
      const message =
        error.response?.data?.message || `Failed to ${editingSecurity ? 'update' : 'create'} security`;
      toast.error(message);
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
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update security status');
    }
  };

  const filteredSecurities = searchQuery
    ? securities.filter(
        (s) =>
          s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : securities;

  const activeCount = securities.filter((s) => s.isActive).length;
  const inactiveCount = securities.filter((s) => !s.isActive).length;

  // Get unique security types
  const securityTypes = [...new Set(securities.map((s) => s.securityType).filter(Boolean))];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-12 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Securities</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage your stocks, ETFs, mutual funds, and other securities
              </p>
            </div>
            <Button onClick={handleCreateNew}>+ New Security</Button>
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
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                      Total Securities
                    </dt>
                    <dd className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {securities.length}
                    </dd>
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
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                      Active
                    </dt>
                    <dd className="text-lg font-semibold text-green-600 dark:text-green-400">
                      {activeCount}
                    </dd>
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
                    className="h-6 w-6 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                    />
                  </svg>
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
                      Inactive
                    </dt>
                    <dd className="text-lg font-semibold text-gray-600 dark:text-gray-400">
                      {inactiveCount}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
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
        {showForm && (
          <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-80 flex items-center justify-center p-4 z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-lg w-full max-h-[90vh] overflow-y-auto p-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                {editingSecurity ? 'Edit Security' : 'New Security'}
              </h2>
              <SecurityForm
                security={editingSecurity}
                onSubmit={handleFormSubmit}
                onCancel={handleFormCancel}
              />
            </div>
          </div>
        )}

        {/* Securities List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
              <p className="mt-2 text-gray-500 dark:text-gray-400">Loading securities...</p>
            </div>
          ) : (
            <SecurityList
              securities={filteredSecurities}
              onEdit={handleEdit}
              onToggleActive={handleToggleActive}
            />
          )}
        </div>
      </div>
    </div>
  );
}
