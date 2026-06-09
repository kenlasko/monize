'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { InstitutionForm } from '@/components/institutions/InstitutionForm';
import { InstitutionList } from '@/components/institutions/InstitutionList';
import { InstitutionAccountsManager } from '@/components/institutions/InstitutionAccountsManager';
import { institutionsApi } from '@/lib/institutions';
import { Institution } from '@/types/institution';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
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
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
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

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await institutionsApi.getAll();
      setInstitutions(data);
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
    const sorted = [...institutions].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    if (!searchQuery) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.website.toLowerCase().includes(q),
    );
  }, [institutions, searchQuery]);

  const totalPages = Math.ceil(filteredInstitutions.length / PAGE_SIZE);
  const paginatedInstitutions = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredInstitutions.slice(start, start + PAGE_SIZE);
  }, [filteredInstitutions, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

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

        <div className="mb-6">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400"
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
