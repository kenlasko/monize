'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/LoadingSkeleton';

/**
 * What the Transactions page draws while `QuickAddDialog`'s chunk loads. The
 * dialog owns its `Modal`, so without this the first opening shows nothing
 * until the chunk arrives and then the whole dialog appears. This is the same
 * `Modal` (size, title, description) over the empty dialog's own rows: the
 * Entry field, the reading status line and the action buttons, at their
 * heights. The page passes it as the dynamic import's `loading`.
 */
export function QuickAddDialogPlaceholder() {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  return (
    <Modal
      isOpen
      maxWidth="2xl"
      className="p-6"
      title={t('quickAdd.title')}
      description={t('quickAdd.description')}
    >
      <div role="status" aria-busy="true">
        <span className="sr-only">{tc('loading')}</span>
        <div aria-hidden="true" className="space-y-4">
          <div>
            <Skeleton className="mb-1 h-5 w-12" />
            <Skeleton className="h-[54px] w-full rounded-md" />
          </div>
          <div className="-mt-2 min-h-4" />
          <div className="flex justify-end space-x-3 pt-4">
            <Skeleton className="h-10 w-20 rounded-md" />
            <Skeleton className="h-10 w-24 rounded-md" />
            <Skeleton className="h-10 w-24 rounded-md" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
