'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';

/** A label line and a 42px field: the height of every input the form draws. */
function FieldPlaceholder({ labelWidth = 'w-24' }: { labelWidth?: string }) {
  return (
    <div>
      <Skeleton className={`mb-2 h-4 ${labelWidth}`} />
      <Skeleton className="h-[42px] w-full rounded-md" />
    </div>
  );
}

/**
 * What a transaction dialog shows while `TransactionForm`'s chunk loads: the
 * form's own rows (mode tabs, Account and Date, Payee and Category, Amount and
 * Reference, Description, Tags and Status, Attachments, the action buttons) at
 * their own heights, so the dialog opens at its full size instead of as a bare
 * title bar that grows when the form arrives. Every host that loads the form
 * with `next/dynamic` passes this as `loading`.
 */
export function TransactionFormPlaceholder() {
  const t = useTranslations('common');
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{t('loading')}</span>
      <div aria-hidden="true" className="space-y-4">
        <div className="flex space-x-2 border-b pb-2 dark:border-gray-700">
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldPlaceholder labelWidth="w-20" />
          <FieldPlaceholder labelWidth="w-12" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldPlaceholder labelWidth="w-16" />
          <FieldPlaceholder labelWidth="w-20" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldPlaceholder labelWidth="w-16" />
          <FieldPlaceholder labelWidth="w-32" />
        </div>
        <FieldPlaceholder labelWidth="w-24" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldPlaceholder labelWidth="w-12" />
          <FieldPlaceholder labelWidth="w-14" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </div>
        <div className="flex justify-end space-x-3 pt-4">
          <Skeleton className="h-10 w-20 rounded-md" />
          <Skeleton className="h-10 w-44 rounded-md" />
        </div>
      </div>
    </div>
  );
}
