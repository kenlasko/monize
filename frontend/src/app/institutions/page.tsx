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
import { Institution } from '@/types/institution';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CARD_CLASS } from '@/components/ui/Card';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { PAGE_SIZE } from '@/lib/constants';
import { docsUrl } from '@/lib/docs-links';

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
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<InstitutionSortField>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const [managing, setManaging] = useState<Institution | null>(null);
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

  // The mount load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const data = await institutionsApi.getAll();
        setInstitutions(data);
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

  const filteredInstitutions = useMemo(() => {
    let result = institutions;
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
  }, [institutions, searchQuery, sortField, sortDirection]);

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

  // A new search starts again from the first page.
  const handleSearchChange = (query: string) => {
    if (query !== searchQuery) setCurrentPage(1);
    setSearchQuery(query);
  };

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
          helpUrl={docsUrl('institutions')}
          actions={<Button onClick={openCreate}>{t('page.newInstitution')}</Button>}
        />

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
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

        <div className="mb-6 flex flex-wrap items-center gap-4">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            aria-label={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="block w-full sm:w-auto sm:flex-1 sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
          />
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

        <div className={`${CARD_CLASS} overflow-hidden`}>
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
