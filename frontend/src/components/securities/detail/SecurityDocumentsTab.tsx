'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import {
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { useDateFormat } from '@/hooks/useDateFormat';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { documentHost } from '@/lib/security-detail';
import { SecurityDocumentForm } from './SecurityDocumentForm';
import { SecurityIssueLetters } from './SecurityIssueLetters';
import { Th } from '@/components/ui/Table';
import type {
  CreateSecurityDocumentData,
  Security,
  SecurityDocument,
} from '@/types/investment';

interface SecurityDocumentsTabProps {
  security: Security;
  /**
   * Bumped by the page each time a price refresh completes (whatever its
   * outcome): the bond data the refresh fetched is re-read once, in place.
   */
  refreshVersion?: number;
}

const TD = 'px-3 py-2 text-sm';

/**
 * The documents recorded against a security: a factsheet, a KIID, a prospectus,
 * an annual report.
 *
 * A plain table of what the columns actually hold, so type, name and date sort
 * the way a reader expects -- the reason these are real columns rather than a
 * JSON blob (discussion #964). The address column shows the host rather than the
 * whole URL: a factsheet link runs to a couple of hundred characters and none of
 * them tell you as much as "ishares.com" does.
 *
 * Links only for now. Uploading a file needs the attachments module widened
 * beyond transactions, which is its own change.
 */
export function SecurityDocumentsTab({ security, refreshVersion = 0 }: SecurityDocumentsTabProps) {
  const t = useTranslations('securityDetail');
  const { formatDate } = useDateFormat();

  const [documents, setDocuments] = useState<SecurityDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<SecurityDocument | undefined>();
  const [deleting, setDeleting] = useState<SecurityDocument | undefined>();

  const fetchDocuments = useCallback(() => {
    // The writes live in the inner function so they run after the request,
    // not during the effect that starts it.
    const run = async () => {
      try {
        const loaded = await investmentsApi.getSecurityDocuments(security.id);
        setDocuments(loaded);
      } catch (err) {
        setError(getErrorMessage(err, t('documents.loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [security.id, t]);

  // Every reload after a change shows the spinner again.
  const load = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchDocuments();
  }, [fetchDocuments]);

  // A different security is a new request: it shows as loading from the
  // render that asks for it (the "info from previous render" pattern). The
  // first load needs nothing here, `isLoading` starts true and `error` null.
  const [loadingFor, setLoadingFor] = useState(security.id);
  if (loadingFor !== security.id) {
    setLoadingFor(security.id);
    setIsLoading(true);
    setError(null);
  }

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const openCreate = () => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditing(undefined);
  };

  const handleSubmit = async (data: CreateSecurityDocumentData) => {
    try {
      if (editing) {
        await investmentsApi.updateSecurityDocument(
          security.id,
          editing.id,
          data,
        );
        toast.success(t('documents.toasts.updated'));
      } else {
        await investmentsApi.createSecurityDocument(security.id, data);
        toast.success(t('documents.toasts.created'));
      }
      setIsFormOpen(false);
      setEditing(undefined);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('documents.toasts.saveFailed')));
      // Rethrown so the form knows it failed and stays open with the values in it.
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await investmentsApi.deleteSecurityDocument(security.id, deleting.id);
      toast.success(t('documents.toasts.deleted'));
      setDeleting(undefined);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t('documents.toasts.deleteFailed')));
    }
  };

  const actionsFor = useCallback(
    (document: SecurityDocument): RowAction[] => [
      {
        key: 'edit',
        label: t('documents.actions.edit'),
        icon: 'edit',
        tone: 'primary',
        onClick: () => {
          setEditing(document);
          setIsFormOpen(true);
        },
      },
      {
        key: 'delete',
        label: t('documents.actions.delete'),
        icon: 'delete',
        tone: 'delete',
        destructive: true,
        onClick: () => setDeleting(document),
      },
    ],
    [t],
  );

  const rows = useMemo(
    () =>
      documents.map((document) => ({
        document,
        host: documentHost(document.url),
        actions: actionsFor(document),
      })),
    [documents, actionsFor],
  );

  const addButton = (
    <Button onClick={openCreate}>{t('documents.add')}</Button>
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <>
      {/* Above the reader's own documents; a plain security has no such section. */}
      {security.bondProgramId && (
        <SecurityIssueLetters
          security={security}
          className="mb-6"
          refreshVersion={refreshVersion}
        />
      )}
    <div className={`${CARD_CLASS} p-4`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('documents.title')}
        </h3>
        {/* Also on error: the first-run panel is suppressed then, and leaving
            no way to add a document would make a failed read a dead end. */}
        {(documents.length > 0 || !!error) && addButton}
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* `!error` matters: a failed load leaves the list empty too, and showing
          "No documents yet" under the error would assert there are none when in
          fact none could be read. */}
      {!error && documents.length === 0 ? (
        // Not an empty table with headers over nothing: a first-run state that
        // says what documents are for and offers the one action worth taking.
        <div className="py-10 text-center">
          <DocumentTextIcon
            className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <p className="mt-3 font-medium text-gray-900 dark:text-gray-100">
            {t('documents.empty.title')}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t('documents.empty.description')}
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={openCreate}>{t('documents.empty.action')}</Button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <Th scope="col" className="px-3 py-2">
                  {t('documents.columns.type')}
                </Th>
                <Th scope="col" className="px-3 py-2">
                  {t('documents.columns.name')}
                </Th>
                <Th scope="col" className="px-3 py-2 hidden sm:table-cell">
                  {t('documents.columns.date')}
                </Th>
                <Th scope="col" className="px-3 py-2 hidden md:table-cell">
                  {t('documents.columns.address')}
                </Th>
                <Th scope="col" align="right" className="px-3 py-2">
                  {t('documents.columns.actions')}
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map(({ document, host, actions }) => (
                <tr
                  key={document.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td
                    className={`${TD} whitespace-nowrap text-gray-500 dark:text-gray-400`}
                  >
                    {t(
                      `documents.types.${document.documentType}` as Parameters<
                        typeof t
                      >[0],
                    )}
                  </td>
                  <td className={`${TD} text-gray-900 dark:text-gray-100`}>
                    <div className="font-medium">{document.name}</div>
                    {document.notes && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {document.notes}
                      </div>
                    )}
                  </td>
                  <td
                    className={`${TD} hidden whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300 sm:table-cell`}
                  >
                    {document.documentDate
                      ? formatDate(document.documentDate)
                      : t('documents.noDate')}
                  </td>
                  <td
                    className={`${TD} hidden text-gray-500 dark:text-gray-400 md:table-cell`}
                  >
                    {host}
                  </td>
                  <td className={`${TD} text-right`}>
                    <div className="flex items-center justify-end gap-1">
                      {/* `noreferrer` as well as `noopener`: the destination is
                          a URL the user typed, and it has no business learning
                          which page they came from. */}
                      <a
                        href={document.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('documents.actions.openNamed', {
                          name: document.name,
                        })}
                        title={document.url}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
                      >
                        <ArrowTopRightOnSquareIcon
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                        {t('documents.actions.open')}
                      </a>
                      <RowActions actions={actions} density="compact" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={isFormOpen}
        onClose={closeForm}
        maxWidth="lg"
        className="p-6"
        pushHistory
        title={editing ? t('documents.form.editTitle') : t('documents.form.addTitle')}
      >
        {isFormOpen && (
          <SecurityDocumentForm
            document={editing}
            onSubmit={handleSubmit}
            onCancel={closeForm}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={!!deleting}
        title={t('documents.delete.title')}
        message={t('documents.delete.message', { name: deleting?.name ?? '' })}
        confirmLabel={t('documents.actions.delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(undefined)}
      />
    </div>
    </>
  );
}
