'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Institution } from '@/types/institution';
import { institutionsApi } from '@/lib/institutions';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { useTableDensity, DensityLevel } from '@/hooks/useTableDensity';
import { InstitutionLogo } from './InstitutionLogo';

const logger = createLogger('InstitutionList');

interface InstitutionListProps {
  institutions: Institution[];
  onEdit: (institution: Institution) => void;
  onDelete: (id: string) => void;
  onManageAccounts: (institution: Institution) => void;
  density?: DensityLevel;
}

export function InstitutionList({
  institutions,
  onEdit,
  onDelete,
  onManageAccounts,
  density = 'normal',
}: InstitutionListProps) {
  const t = useTranslations('institutions');
  const tc = useTranslations('common');
  const { cellPadding, headerPadding } = useTableDensity(density);
  const [toDelete, setToDelete] = useState<Institution | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteConfirm = async () => {
    if (!toDelete) return;
    setIsDeleting(true);
    try {
      await institutionsApi.delete(toDelete.id);
      toast.success(t('list.deleted', { name: toDelete.name }));
      onDelete(toDelete.id);
      setToDelete(null);
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.deleteFailed')));
      logger.error(error);
    } finally {
      setIsDeleting(false);
    }
  };

  if (institutions.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">{t('list.empty')}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
              {t('list.columns.name')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell`}>
              {t('list.columns.website')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
              {t('list.columns.country')}
            </th>
            <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
              {t('list.columns.accounts')}
            </th>
            <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
              {t('list.columns.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {institutions.map((institution) => (
            <tr
              key={institution.id}
              className="hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <td className={cellPadding}>
                <div className="flex items-center gap-3 min-w-0">
                  <InstitutionLogo institution={institution} size={24} fallbackGlyph="$" />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {institution.name}
                  </span>
                </div>
              </td>
              <td className={`${cellPadding} hidden md:table-cell max-w-[16rem]`}>
                <a
                  href={institution.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline truncate inline-block max-w-full"
                >
                  {institution.website}
                </a>
              </td>
              <td className={`${cellPadding} hidden sm:table-cell text-sm text-gray-500 dark:text-gray-400`}>
                {institution.country || '—'}
              </td>
              <td className={cellPadding}>
                <button
                  onClick={() => onManageAccounts(institution)}
                  aria-label={t('list.accountCount', { count: institution.accountCount })}
                  title={t('list.actions.manageAccounts')}
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {institution.accountCount}
                </button>
              </td>
              <td className={`${cellPadding} text-right whitespace-nowrap ${density === 'dense' ? 'space-x-1' : 'space-x-2'}`}>
                {density === 'dense' ? (
                  <>
                    <button
                      onClick={() => onEdit(institution)}
                      aria-label={tc('edit')}
                      title={tc('edit')}
                      className="inline-flex items-center p-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <PencilSquareIcon className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => setToDelete(institution)}
                      aria-label={tc('delete')}
                      title={tc('delete')}
                      className="inline-flex items-center p-1.5 rounded text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <TrashIcon className="h-5 w-5" />
                    </button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEdit(institution)}
                    >
                      {tc('edit')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setToDelete(institution)}
                    >
                      {tc('delete')}
                    </Button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        isOpen={toDelete !== null}
        title={t('list.deleteTitle')}
        message={
          toDelete ? t('list.deleteMessage', { name: toDelete.name }) : ''
        }
        confirmLabel={
          isDeleting ? t('list.deleting') : tc('delete')
        }
        cancelLabel={tc('cancel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
