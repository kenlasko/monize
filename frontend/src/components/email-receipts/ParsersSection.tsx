'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { DocumentTextIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ParserEditorDialog } from '@/components/email-receipts/ParserEditorDialog';
import { ParserJsonDialog } from '@/components/email-receipts/ParserJsonDialog';
import { ProcessStatus } from '@/components/email-receipts/ProcessStatus';
import { ProfileWizard } from '@/components/email-receipts/ProfileWizard';
import { UncoveredDomainsSection } from '@/components/email-receipts/UncoveredDomainsSection';
import { useProfileDiscardOffer } from '@/components/email-receipts/useProfileDiscardOffer';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { RowActions, type RowAction } from '@/components/ui/row-actions';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useProcessStoredEmails } from '@/hooks/useProcessStoredEmails';
import { useReceiptParserLookups } from '@/hooks/useReceiptParserLookups';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { processableForDomains } from '@/lib/email-receipts-format';
import { discardModeOf, isTradeDefinition } from '@/lib/receipt-parser-form';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import type { EmailReceiptParser } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptParsers');

/** The editor is closed, writing a new parser, or editing one. */
type EditorTarget = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; parser: EmailReceiptParser };

const isConflict = (error: unknown): boolean => error instanceof AxiosError && error.response?.status === 409;

/**
 * The profiles tab of `/email-receipts`: the list, and the dialog that
 * creates and edits one. `parsers === null` is loading or failed, never an
 * empty list. A draft (written by the AI from one sample email) reads nothing
 * until a person approves it, so the list says which ones are waiting. Approving one
 * asks whether to run the stored emails of its sender domains through it now, so
 * emails that arrived before the profile do not wait for a manual reprocess.
 */
interface ParsersSectionProps {
  /** The domain the profile wizard is open for (the hub keeps it in `?wizard=`); `null` or absent when closed. */
  wizardDomain?: string | null;
  onWizardDomainChange?: (domain: string | null) => void;
  /** Switches the hub to the Emails tab (the hint on linked profiles links there). */
  onOpenEmails?: () => void;
}

export function ParsersSection({ wizardDomain = null, onWizardDomainChange, onOpenEmails }: ParsersSectionProps = {}) {
  const t = useTranslations('emailReceipts.parsers');
  const tc = useTranslations('common');
  const { state: lookups, reload: reloadLookups } = useReceiptParserLookups();
  const [parsers, setParsers] = useState<EmailReceiptParser[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editor, setEditor] = useState<EditorTarget>({ kind: 'closed' });
  const [jsonTarget, setJsonTarget] = useState<EmailReceiptParser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EmailReceiptParser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The approved profile and how many stored emails of its senders could be processed now.
  const [processOffer, setProcessOffer] = useState<{ parser: EmailReceiptParser; count: number } | null>(null);
  const { state: processState, run: runProcess, cancel: cancelProcess, dismiss: dismissProcess } = useProcessStoredEmails();
  // Only the newest load may write the list (a reload after a 409 must not be
  // overwritten by a slower answer to an earlier request).
  const latestLoad = useRef(0);
  // Bumped when the wizard finishes, so the cloud of uncovered domains is read again.
  const [uncoveredAttempt, setUncoveredAttempt] = useState(0);

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const load = useCallback(() => {
    const run = async () => {
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
    };
    return run();
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A profile that ignores or deletes its emails offers to do so to the stored ones it matches.
  const discardOffer = useProfileDiscardOffer(() => void load());

  const payeeNames = useMemo(
    () => (lookups.status === 'ready' ? new Map(lookups.lookups.payees.map((p) => [p.value, p.label])) : null),
    [lookups],
  );

  /** Offer to process the stored emails the approved profile now covers; no offer when none, or when the count is unknown. */
  const offerProcessing = async (parser: EmailReceiptParser) => {
    try {
      const count = processableForDomains(await emailReceiptsApi.receipts.listDomains(), parser.fromDomains);
      if (count > 0) setProcessOffer({ parser, count });
    } catch (error) {
      logger.error(error);
    }
  };

  const confirmProcess = () => {
    const offer = processOffer;
    setProcessOffer(null);
    if (offer) void runProcess(offer.parser.fromDomains);
  };

  const handleApprove = async (parser: EmailReceiptParser) => {
    setBusyId(parser.id);
    try {
      const approved = await emailReceiptsApi.parsers.approve(parser.id, parser.revision);
      setParsers((prev) => prev && prev.map((p) => (p.id === approved.id ? approved : p)));
      toast.success(t('toasts.approved'));
      // A profile that discards its emails offers that instead of reading the stored ones.
      if (discardModeOf(approved.definition) !== null) void discardOffer.offer(approved);
      else void offerProcessing(approved);
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

  /** Run the profile's domains through the pipeline again; the row's count is read again afterwards. */
  const handleReparse = async (parser: EmailReceiptParser) => {
    await runProcess(parser.fromDomains);
    void load();
  };

  const handleSaved = (saved: EmailReceiptParser) => {
    setEditor({ kind: 'closed' });
    void load();
    void discardOffer.offer(saved);
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
      key: 'viewJson',
      label: t('actions.viewJson'),
      icon: 'view',
      tone: 'view',
      onClick: () => setJsonTarget(parser),
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
    body = (
      <EmptyState
        icon={<DocumentTextIcon />}
        title={t('empty.title')}
        description={t('empty.body')}
        help="emailReceipts"
      />
    );
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
                  {parser.status === 'approved' && (parser.reprocessableCount ?? 0) > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={processState.status === 'running'}
                      onClick={() => void handleReparse(parser)}
                    >
                      {t('reparse', { count: parser.reprocessableCount ?? 0 })}
                    </Button>
                  )}
                </Td>
                <Td className="px-2 align-top sm:px-4">
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={parser.status === 'approved' ? 'green' : 'amber'}>
                      {t(`status.${parser.status}`)}
                    </Badge>
                    <Badge variant={parser.source === 'ai' ? 'purple' : 'gray'}>{t(`source.${parser.source}`)}</Badge>
                    {/* A trade profile books investment transactions, not bank-transaction splits. */}
                    {isTradeDefinition(parser.definition) && <Badge variant="blue">{t('kindTrade')}</Badge>}
                    {/* A profile for mail that is never wanted: it ignores or deletes what it matches. */}
                    {discardModeOf(parser.definition) === 'ignore' && <Badge variant="gray">{t('discardIgnore')}</Badge>}
                    {discardModeOf(parser.definition) === 'delete' && <Badge variant="red">{t('discardDelete')}</Badge>}
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
                  <RowActions actions={actionsFor(parser)} density="normal" maxInline={4} />
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
        <Button variant="outline" className="w-full sm:w-auto" onClick={() => setEditor({ kind: 'new' })}>
          {t('newButton')}
        </Button>
      </div>
      {wizardDomain !== null && onWizardDomainChange ? (
        <ProfileWizard
          domain={wizardDomain}
          onClose={() => onWizardDomainChange(null)}
          onFinished={() => {
            void load();
            setUncoveredAttempt((n) => n + 1);
          }}
        />
      ) : (
        <UncoveredDomainsSection
          refreshKey={uncoveredAttempt}
          onSelect={(domain) => onWizardDomainChange?.(domain)}
          disabled={!onWizardDomainChange}
          onOpenEmails={onOpenEmails}
        />
      )}
      {processState.status !== 'idle' && (
        <div className="mb-3">
          <ProcessStatus state={processState} onCancel={cancelProcess} onDismiss={dismissProcess} />
        </div>
      )}
      <Card className="overflow-hidden" {...(parsers !== null && parsers.length > 0 ? tourAnchor(TOUR_ANCHORS.emailReceiptsProfiles) : {})}>
        {body}
      </Card>

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

      {jsonTarget !== null && <ParserJsonDialog parser={jsonTarget} onClose={() => setJsonTarget(null)} />}

      <ConfirmDialog
        isOpen={processOffer !== null}
        title={t('processOffer.title')}
        message={t('processOffer.message', {
          count: processOffer?.count ?? 0,
          domains: processOffer?.parser.fromDomains.join(', ') ?? '',
        })}
        confirmLabel={t('processOffer.confirm')}
        cancelLabel={t('processOffer.later')}
        variant="info"
        onConfirm={confirmProcess}
        onCancel={() => setProcessOffer(null)}
      />

      {discardOffer.dialog}

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
