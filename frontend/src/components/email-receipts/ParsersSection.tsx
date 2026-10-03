'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { DocumentTextIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ParserEditorDialog } from '@/components/email-receipts/ParserEditorDialog';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RowActions, type RowAction } from '@/components/ui/row-actions';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useReceiptParserLookups } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptParser } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptParsers');

/** The editor is closed, writing a new parser, or editing one. */
type EditorTarget = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; parser: EmailReceiptParser };

const isConflict = (error: unknown): boolean => error instanceof AxiosError && error.response?.status === 409;

/**
 * The parsers half of `/settings/email-receipts`: the list, and the dialog that
 * creates and edits one. `parsers === null` is loading or failed, never an
 * empty list. A draft (written by the AI from one sample email) reads nothing
 * until a person approves it, so the list says which ones are waiting.
 */
export function ParsersSection() {
  const t = useTranslations('emailReceipts.parsers');
  const tc = useTranslations('common');
  const { state: lookups, reload: reloadLookups } = useReceiptParserLookups();
  const [parsers, setParsers] = useState<EmailReceiptParser[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editor, setEditor] = useState<EditorTarget>({ kind: 'closed' });
  const [deleteTarget, setDeleteTarget] = useState<EmailReceiptParser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Only the newest load may write the list (a reload after a 409 must not be
  // overwritten by a slower answer to an earlier request).
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const data = await emailReceiptsApi.parsers.list();
      if (request !== latestLoad.current) return;
      setParsers(data);
      setLoadFailed(false);
    } catch (error) {
      if (request !== latestLoad.current) return;
      logger.error(error);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const payeeNames = useMemo(
    () => (lookups.status === 'ready' ? new Map(lookups.lookups.payees.map((p) => [p.value, p.label])) : null),
    [lookups],
  );

  const handleApprove = async (parser: EmailReceiptParser) => {
    setBusyId(parser.id);
    try {
      const approved = await emailReceiptsApi.parsers.approve(parser.id, parser.revision);
      setParsers((prev) => prev && prev.map((p) => (p.id === approved.id ? approved : p)));
      toast.success(t('toasts.approved'));
    } catch (error) {
      if (isConflict(error)) {
        toast.error(t('toasts.changedElsewhere'));
        await load();
      } else {
        toast.error(getErrorMessage(error, t('toasts.approveFailed')));
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setBusyId(target.id);
    try {
      await emailReceiptsApi.parsers.remove(target.id);
      setParsers((prev) => prev && prev.filter((p) => p.id !== target.id));
      toast.success(t('toasts.deleted'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = () => {
    setEditor({ kind: 'closed' });
    void load();
  };

  const handleConflict = () => {
    setEditor({ kind: 'closed' });
    void load();
  };

  const actionsFor = (parser: EmailReceiptParser): RowAction[] => [
    {
      key: 'edit',
      label: tc('edit'),
      icon: 'edit',
      tone: 'primary',
      onClick: () => setEditor({ kind: 'edit', parser }),
      disabled: busyId === parser.id,
    },
    {
      key: 'approve',
      label: t('actions.approve'),
      icon: 'activate',
      tone: 'success',
      onClick: () => void handleApprove(parser),
      hidden: parser.status !== 'draft' || !parser.definitionValid,
      disabled: busyId === parser.id,
    },
    {
      key: 'delete',
      label: tc('delete'),
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => setDeleteTarget(parser),
      disabled: busyId === parser.id,
    },
  ];

  let body;
  if (parsers === null && loadFailed) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={
            <Button
              onClick={() => {
                setLoadFailed(false);
                void load();
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (parsers === null) {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (parsers.length === 0) {
    body = <EmptyState icon={<DocumentTextIcon />} title={t('empty.title')} description={t('empty.body')} />;
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <Th className="px-2 sm:px-4">{t('columns.name')}</Th>
              <Th className="px-2 sm:px-4">{t('columns.status')}</Th>
              <Th className="hidden px-2 sm:table-cell sm:px-4">{t('columns.payee')}</Th>
              <Th align="right" className="px-2 sm:px-4">
                {t('columns.actions')}
              </Th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY_CLASS}>
            {parsers.map((parser) => (
              <tr key={parser.id}>
                <Td className="px-2 align-top sm:px-4 break-words">
                  <div className="font-medium">{parser.name}</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{parser.fromDomains.join(', ')}</div>
                </Td>
                <Td className="px-2 align-top sm:px-4">
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={parser.status === 'approved' ? 'green' : 'amber'}>
                      {t(`status.${parser.status}`)}
                    </Badge>
                    <Badge variant={parser.source === 'ai' ? 'purple' : 'gray'}>{t(`source.${parser.source}`)}</Badge>
                    {!parser.definitionValid && <Badge variant="red">{t('invalid')}</Badge>}
                  </div>
                </Td>
                <Td className="hidden px-2 align-top sm:table-cell sm:px-4">
                  {parser.payeeId === null ? (
                    <span className="text-gray-500 dark:text-gray-400">{t('noPayee')}</span>
                  ) : payeeNames !== null ? (
                    (payeeNames.get(parser.payeeId) ?? (
                      <span className="text-gray-500 dark:text-gray-400">{t('payeeUnknown')}</span>
                    ))
                  ) : lookups.status === 'error' ? (
                    // A list that failed to load says nothing about the payee.
                    <span className="text-gray-500 dark:text-gray-400">{t('payeeUnavailable')}</span>
                  ) : null}
                </Td>
                <Td align="right" className="px-2 align-top sm:px-4">
                  <RowActions actions={actionsFor(parser)} density="normal" maxInline={3} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-labelledby="email-receipts-parsers-heading" className="mb-8">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="email-receipts-parsers-heading" className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('heading')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('description')}</p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setEditor({ kind: 'new' })}>
          {t('newButton')}
        </Button>
      </div>
      <Card className="overflow-hidden">{body}</Card>

      {editor.kind !== 'closed' && (
        <ParserEditorDialog
          parser={editor.kind === 'edit' ? editor.parser : null}
          lookups={lookups}
          onReloadLookups={reloadLookups}
          onClose={() => setEditor({ kind: 'closed' })}
          onSaved={handleSaved}
          onConflict={handleConflict}
        />
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('deleteDialog.title')}
        message={t('deleteDialog.message', { name: deleteTarget?.name ?? '' })}
        confirmLabel={tc('delete')}
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
