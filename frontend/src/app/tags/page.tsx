'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/Button';
const TagForm = dynamic(() => import('@/components/tags/TagForm').then(m => m.TagForm), { ssr: false });
import { TagList, type DensityLevel, type SortField, type SortDirection } from '@/components/tags/TagList';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { tagsApi } from '@/lib/tags';
import { Tag } from '@/types/tag';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Tags');

export default function TagsPage() {
  return (
    <ProtectedRoute>
      <TagsContent />
    </ProtectedRoute>
  );
}

function TagsContent() {
  const t = useTranslations('tags');
  const tc = useTranslations('common');
  const router = useRouter();
  const [tags, setTags] = useState<Tag[]>([]);
  const [transactionCounts, setTransactionCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-tags-density', 'normal');
  const [sortField, setSortField] = useLocalStorage<SortField>('monize-tags-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-tags-sort-dir', 'asc');
  const [deleteTag, setDeleteTag] = useState<Tag | null>(null);
  const [deleteTransactionCount, setDeleteTransactionCount] = useState<number>(0);
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Tag>();

  const loadTags = useCallback(async () => {
    setIsLoading(true);
    try {
      const [data, counts] = await Promise.all([
        tagsApi.getAll(),
        tagsApi.getAllTransactionCounts(),
      ]);
      setTags(data);
      setTransactionCounts(counts);
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  useOnUndoRedo(loadTags);
  // Refresh on AI chat-bubble writes the same way as undo/redo.
  useOnAiAction(loadTags);

  const handleFormSubmit = async (data: any) => {
    try {
      const cleanedData = {
        ...data,
        color: data.color || null,
        icon: data.icon || null,
      };

      if (editingItem) {
        await tagsApi.update(editingItem.id, cleanedData);
        toast.success(t('page.toasts.updated'));
        close();
        loadTags();
      } else {
        await tagsApi.create(cleanedData);
        toast.success(t('page.toasts.created'));
        close();
        loadTags();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, editingItem ? t('page.toasts.updateFailed') : t('page.toasts.createFailed')));
      throw error;
    }
  };

  const handleDeleteClick = useCallback(async (tag: Tag) => {
    try {
      const count = await tagsApi.getTransactionCount(tag.id);
      setDeleteTransactionCount(count);
    } catch {
      setDeleteTransactionCount(0);
    }
    setDeleteTag(tag);
  }, []);

  const handleConfirmDelete = async () => {
    if (!deleteTag) return;

    try {
      await tagsApi.delete(deleteTag.id);
      toast.success(t('page.toasts.deleted'));
      setTags(prev => prev.filter(tag => tag.id !== deleteTag.id));
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeleteTag(null);
    }
  };

  const filteredTags = useMemo(() => {
    if (!searchQuery) return tags;
    return tags.filter((t) =>
      t.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [tags, searchQuery]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'createdAt' ? 'desc' : 'asc');
    }
  }, [sortField, setSortField, setSortDirection]);

  const handleTagClick = useCallback((tag: Tag) => {
    router.push(`/transactions?tagIds=${tag.id}`);
  }, [router]);

  const tagsWithColor = tags.filter((t) => t.color).length;
  const tagsWithIcon = tags.filter((t) => t.icon).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          actions={<Button onClick={openCreate}>{t('page.newButton')}</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <SummaryCard
            label={t('page.summary.totalTags')}
            value={tags.length}
            icon={SummaryIcons.tag}
          />
          <SummaryCard
            label={t('page.summary.tagsWithColour')}
            value={tagsWithColor}
            icon={SummaryIcons.plusCircle}
            valueColor="blue"
          />
          <SummaryCard
            label={t('page.summary.tagsWithIcon')}
            value={tagsWithIcon}
            icon={SummaryIcons.list}
            valueColor="blue"
          />
        </div>

        {/* Search */}
        <div className="mb-6">
          <input
            type="text"
            placeholder={t('page.search.placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" allowOverflow className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('page.modal.editTitle') : t('page.modal.newTitle')}
          </h2>
          <TagForm
            tag={editingItem}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Delete Confirmation */}
        <ConfirmDialog
          isOpen={deleteTag !== null}
          title={t('page.delete.title')}
          message={
            deleteTransactionCount > 0
              ? t('page.delete.withTransactionsMessage', { name: deleteTag?.name ?? '', count: deleteTransactionCount })
              : t('page.delete.simpleMessage', { name: deleteTag?.name ?? '' })
          }
          confirmLabel={tc('delete')}
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTag(null)}
        />

        {/* Tags List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : tags.length === 0 ? (
            <div className="p-12 text-center">
              <svg
                className="mx-auto h-16 w-16 text-gray-400 dark:text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-gray-100">
                {t('page.emptyState.title')}
              </h3>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
                {t('page.emptyState.body')}
              </p>
              <div className="mt-6">
                <Button onClick={openCreate}>
                  {t('page.emptyState.createButton')}
                </Button>
              </div>
            </div>
          ) : (
            <TagList
              tags={filteredTags}
              transactionCounts={transactionCounts}
              onEdit={openEdit}
              onDelete={handleDeleteClick}
              onTagClick={handleTagClick}
              density={listDensity}
              onDensityChange={setListDensity}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}
        </div>

        {/* Total count */}
        {filteredTags.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('page.totalCount', { count: filteredTags.length })}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
