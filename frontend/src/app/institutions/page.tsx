'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { InstitutionForm } from '@/components/institutions/InstitutionForm';
import {
  InstitutionList,
  type InstitutionSortField,
} from '@/components/institutions/InstitutionList';
import { InstitutionAccountsManager } from '@/components/institutions/InstitutionAccountsManager';
import { institutionsApi } from '@/lib/institutions';
import { accountsApi } from '@/lib/accounts';
import { countLogicalAccounts } from '@/lib/account-utils';
import { Institution } from '@/types/institution';
import { Account } from '@/types/account';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { DensityLevel } from '@/hooks/useTableDensity';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { PAGE_SIZE } from '@/lib/constants';

const logger = createLogger('Institutions');

export default function InstitutionsPage() {
  return (
    <ProtectedRoute>
      <InstitutionsContent />
    </ProtectedRoute>
  );
}

function InstitutionsContent() {
  const t = useTranslations('institutions');
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>('');
  const [sortField, setSortField] = useState<InstitutionSortField>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [managing, setManaging] = useState<Institution | null>(null);
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>(
    'monize-institutions-density',
    'normal',
  );
  const {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Institution>();

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Accounts are loaded to derive each institution's active/closed status
      // (an institution has no status of its own).
      const [data, accountsData] = await Promise.all([
        institutionsApi.getAll(),
        accountsApi.getAll(true).catch(() => [] as Account[]),
      ]);
      setInstitutions(data);
      setAccounts(accountsData);
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useOnUndoRedo(loadData);
  // Refresh on AI chat-bubble writes the same way as undo/redo.
  useOnAiAction(loadData);

  const handleFormSubmit = async (data: {
    name: string;
    website: string;
    country?: string;
  }) => {
    try {
      if (editingItem) {
        const updated = await institutionsApi.update(editingItem.id, data);
        toast.success(t('page.toasts.updated'));
        close();
        setInstitutions((prev) =>
          prev.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)),
        );
      } else {
        const created = await institutionsApi.create(data);
        toast.success(t('page.toasts.created'));
        close();
        setInstitutions((prev) => [created, ...prev]);
      }
    } catch (error) {
      toast.error(
        getErrorMessage(
          error,
          editingItem
            ? t('page.toasts.updateFailed')
            : t('page.toasts.createFailed'),
        ),
      );
      throw error;
    }
  };

  // Logical (pair-aware) account counts per institution, split by status, so
  // the Accounts column can reflect the All/Active/Closed filter without
  // hiding any institution rows.
  const accountCountByStatus = useMemo(() => {
    const groups = new Map<string, Account[]>();
    for (const account of accounts) {
      if (!account.institutionId) continue;
      const arr = groups.get(account.institutionId) ?? [];
      groups.set(account.institutionId, [...arr, account]);
    }
    const map = new Map<string, { active: number; closed: number }>();
    for (const [id, arr] of groups) {
      map.set(id, {
        active: countLogicalAccounts(arr.filter((a) => !a.isClosed)),
        closed: countLogicalAccounts(arr.filter((a) => a.isClosed)),
      });
    }
    return map;
  }, [accounts]);

  // Apply the status filter to the displayed account count (rows are kept).
  const decoratedInstitutions = useMemo(() => {
    if (!filterStatus) return institutions;
    return institutions.map((i) => {
      const counts = accountCountByStatus.get(i.id);
      const accountCount = counts
        ? filterStatus === 'active'
          ? counts.active
          : counts.closed
        : 0;
      return { ...i, accountCount };
    });
  }, [institutions, filterStatus, accountCountByStatus]);

  const filteredInstitutions = useMemo(() => {
    let result = decoratedInstitutions;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.website.toLowerCase().includes(q) ||
          (i.country?.toLowerCase().includes(q) ?? false),
      );
    }
    const sorted = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'website':
          cmp = a.website.localeCompare(b.website, undefined, {
            sensitivity: 'base',
          });
          break;
        case 'country':
          cmp = (a.country ?? '').localeCompare(b.country ?? '', undefined, {
            sensitivity: 'base',
          });
          break;
        case 'accounts':
          cmp = a.accountCount - b.accountCount;
          break;
        default:
          cmp = a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
          });
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [decoratedInstitutions, searchQuery, sortField, sortDirection]);

  const handleSort = (field: InstitutionSortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'accounts' ? 'desc' : 'asc');
    }
  };

  const totalPages = Math.ceil(filteredInstitutions.length / PAGE_SIZE);
  const paginatedInstitutions = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredInstitutions.slice(start, start + PAGE_SIZE);
  }, [filteredInstitutions, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterStatus]);

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const withLogoCount = institutions.filter((i) => i.hasLogo).length;
  const linkedAccountsCount = institutions.reduce(
    (sum, i) => sum + (i.accountCount || 0),
    0,
  );

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          actions={<Button onClick={openCreate}>{t('page.newInstitution')}</Button>}
        />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <SummaryCard
            label={t('page.summary.total')}
            value={institutions.length}
            icon={SummaryIcons.accounts}
          />
          <SummaryCard
            label={t('page.summary.withLogo')}
            value={withLogoCount}
            icon={SummaryIcons.checkCircle}
            valueColor="green"
          />
          <SummaryCard
            label={t('page.summary.linkedAccounts')}
            value={linkedAccountsCount}
            icon={SummaryIcons.money}
          />
        </div>

        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
          />
          <div className="inline-flex rounded-md shadow-sm">
            <button
              type="button"
              onClick={() => setFilterStatus('')}
              className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                filterStatus === ''
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('list.statusFilter.all')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('active')}
              className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                filterStatus === 'active'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('list.statusFilter.active')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('closed')}
              className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                filterStatus === 'closed'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('list.statusFilter.closed')}
            </button>
          </div>
        </div>

        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
          </h2>
          <InstitutionForm
            institution={editingItem}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <InstitutionList
              institutions={paginatedInstitutions}
              onEdit={openEdit}
              onDelete={(deletedId) =>
                setInstitutions((prev) => prev.filter((i) => i.id !== deletedId))
              }
              onManageAccounts={setManaging}
              density={listDensity}
              onDensityChange={setListDensity}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}
        </div>

        {totalPages > 1 && (
          <div className="mt-4">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filteredInstitutions.length}
              pageSize={PAGE_SIZE}
              onPageChange={goToPage}
              itemName="institutions"
            />
          </div>
        )}
      </main>

      <InstitutionAccountsManager
        institution={managing}
        isOpen={managing !== null}
        onClose={() => setManaging(null)}
        onChanged={loadData}
      />
    </PageLayout>
  );
}
