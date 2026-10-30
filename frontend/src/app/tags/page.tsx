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
import { TagList, type SortField, type SortDirection } from '@/components/tags/TagList';
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
import { CARD_CLASS } from '@/components/ui/Card';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { docsUrl } from '@/lib/docs-links';

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
  const [sortField, setSortField] = useLocalStorage<SortField>('monize-tags-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-tags-sort-dir', 'asc');
  const [deleteTag, setDeleteTag] = useState<Tag | null>(null);
  const [deleteTransactionCount, setDeleteTransactionCount] = useState<number>(0);
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Tag>();

  // The mount load: the state already says loading.
  const fetchTags = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
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
    };
    return run();
  }, [t]);

  const loadTags = useCallback(() => {
    setIsLoading(true);
    return fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

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
      setSortDirection(field === 'count' ? 'desc' : 'asc');
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
          helpUrl={docsUrl('tags')}
          actions={<Button onClick={openCreate}>{t('page.newButton')}</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-6">
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
        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('page.loading')} />
          ) : (
            <TagList
              tags={filteredTags}
              isFiltered={tags.length > 0}
              onCreate={openCreate}
              transactionCounts={transactionCounts}
              onEdit={openEdit}
              onDelete={handleDeleteClick}
              onTagClick={handleTagClick}
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
