'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Banner } from '@/components/rules/RuleEditorBanners';
import { RuleRunFilterFields } from '@/components/rules/RuleRunFilterFields';
import { RuleRunAiReviewOutcome, RuleRunPreviewTable, RuleRunSkippedList } from '@/components/rules/RuleRunPreviewTable';
import type { RuleOption } from '@/components/rules/use-rule-options';
import { useRuleRunErrorMessage } from '@/components/rules/use-rule-run-error';
import { useRunAccountOptions } from '@/components/rules/use-run-account-options';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { getErrorCode } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_RUN_FILTERS,
  filtersKey,
  filtersToRequest,
  hasBackwardsRange,
  type RunFiltersState,
} from '@/lib/rule-run-filters';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import { notifyUndoRedo } from '@/lib/undoRedoSignal';
import type { RuleRunPreview, RuleRunResult } from '@/types/transaction-rule-run';

const logger = createLogger('RunRuleDialog');

/** The stored rule being run; only what the dialog needs. */
export interface RunnableRule {
  id: string;
  name: string;
}

interface RunRuleDialogProps {
  /** The rule to run; null keeps the dialog closed. */
  rule: RunnableRule | null;
  /** The accounts a run can be limited to; loaded here when the caller has none. */
  accountOptions?: readonly RuleOption[];
  onClose: () => void;
}

/** A run is worth confirming when it changes a row or queues a row for AI review. */
const hasRunWork = (preview: RuleRunPreview): boolean => preview.matched.length > 0 || preview.aiReviewRequests > 0;

/**
 * The toast after a run. The undo promise belongs only to a run that wrote an
 * action-history entry (`historyId`); a run that only queued reviews, or found
 * every review already open, says what happened instead.
 */
function runToastMessage(result: RuleRunResult, t: ReturnType<typeof useTranslations>): string {
  if (result.historyId !== null) return t('toast.done', { count: result.changed });
  if (result.changed > 0) return t('toast.changedNoUndo', { count: result.changed });
  if (result.aiReviewsQueued > 0) return t('toast.aiReviewsQueued', { count: result.aiReviewsQueued });
  if (result.aiReviewsAlreadyQueued > 0) {
    return t('toast.aiReviewsAlreadyQueued', { count: result.aiReviewsAlreadyQueued });
  }
  return t('toast.noChanges');
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** `key` is the filters the preview answered, so it is never confused with other ones. */
  | { status: 'ready'; key: string; preview: RuleRunPreview };

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: RuleRunResult };

function RunRuleBody({ rule, accountOptions, onClose }: RunRuleDialogProps & { rule: RunnableRule }) {
  const t = useTranslations('rules.run');
  const tc = useTranslations('common');
  const errorMessage = useRuleRunErrorMessage();
  const accounts = useRunAccountOptions(accountOptions);
  const [filters, setFilters] = useState<RunFiltersState>(DEFAULT_RUN_FILTERS);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  // Only the newest preview may write the state.
  const latest = useRef(0);

  const key = useMemo(() => filtersKey(filters), [filters]);
  const running = run.status === 'running';
  const loadingPreview = preview.status === 'loading';
  const finished = run.status === 'done';
  const stale = preview.status === 'ready' && preview.key !== key;

  const loadPreview = async (of: RunFiltersState) => {
    const id = ++latest.current;
    const askedKey = filtersKey(of);
    setPreview({ status: 'loading' });
    try {
      const answer = await transactionRulesApi.previewRun(rule.id, filtersToRequest(of));
      if (id === latest.current) setPreview({ status: 'ready', key: askedKey, preview: answer });
    } catch (error) {
      if (id !== latest.current) return;
      logger.error(error);
      setPreview({ status: 'error', message: errorMessage(error, 'previewFailed') });
    }
  };

  const showPreview = () => {
    setNotice(null);
    setRun({ status: 'idle' });
    void loadPreview(filters);
  };

  const confirm = async () => {
    // Only a fresh preview with something to change or to queue for review may be confirmed.
    if (preview.status !== 'ready' || preview.key !== key || !hasRunWork(preview.preview)) return;
    const sent = filters;
    setRun({ status: 'running' });
    setNotice(null);
    try {
      const result = await transactionRulesApi.run(rule.id, filtersToRequest(sent), preview.preview.fingerprint);
      setRun({ status: 'done', result });
      toast.success(runToastMessage(result, t));
      // The action history panel and any open list reload on this signal.
      notifyUndoRedo();
    } catch (error) {
      if (getErrorCode(error) === 'PREVIEW_CHANGED') {
        // Nothing was written. The 409 carries a fingerprint too, but only a
        // preview the reader has seen may be confirmed, so fetch a new one.
        setRun({ status: 'idle' });
        setNotice(t('errors.PREVIEW_CHANGED'));
        await loadPreview(sent);
        return;
      }
      logger.error(error);
      setRun({ status: 'error', message: errorMessage(error, 'runFailed') });
    }
  };

  const canConfirm =
    preview.status === 'ready' && !stale && hasRunWork(preview.preview) && !running && !hasBackwardsRange(filters);

  const footer = finished ? (
    <Button type="button" onClick={onClose}>
      {tc('close')}
    </Button>
  ) : (
    <>
      <Button type="button" variant="outline" onClick={onClose} disabled={running}>
        {tc('cancel')}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={showPreview}
        isLoading={loadingPreview}
        disabled={loadingPreview || running || hasBackwardsRange(filters) || accounts.state.status !== 'ready'}
      >
        {t('previewButton')}
      </Button>
      <Button type="button" onClick={() => void confirm()} isLoading={running} disabled={!canConfirm}>
        {t('confirmButton')}
      </Button>
    </>
  );

  let accountsGate = null;
  if (accounts.state.status === 'loading') accountsGate = <LoadingSpinner text={t('accountsLoading')} />;
  if (accounts.state.status === 'error') {
    accountsGate = (
      <Banner tone="red" title={t('accountsFailed')}>
        <Button type="button" size="sm" variant="outline" onClick={accounts.reload}>
          {t('retry')}
        </Button>
      </Banner>
    );
  }

  return (
    <Modal
      isOpen
      onClose={running ? undefined : onClose}
      title={t('title', { name: rule.name })}
      description={finished ? undefined : t('description')}
      descriptionLearnMore={finished ? undefined : 'rulesRunOnExisting'}
      footer={footer}
      padding="md"
      maxWidth="3xl"
    >
      {finished ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm text-gray-900 dark:text-gray-100">{t('done.summary', { count: run.result.changed })}</p>
          <RuleRunAiReviewOutcome result={run.result} />
          {/* A run that only queued reviews wrote no undo entry. */}
          {run.result.changed > 0 && <p className="text-sm text-gray-600 dark:text-gray-300">{t('done.undo')}</p>}
          <RuleRunSkippedList skipped={run.result.skipped} />
        </div>
      ) : (
        <div className="space-y-4">
          {accountsGate ??
            (accounts.state.status === 'ready' && (
              <RuleRunFilterFields
                filters={filters}
                accountOptions={accounts.state.options}
                onChange={setFilters}
                disabled={running}
              />
            ))}
          {notice && <Banner tone="amber"><p>{notice}</p></Banner>}
          {run.status === 'error' && <Banner tone="red"><p>{run.message}</p></Banner>}
          <div aria-live="polite" aria-busy={loadingPreview || stale}>
            {preview.status === 'idle' && <p className="text-sm text-gray-500 dark:text-gray-400">{t('idle')}</p>}
            {loadingPreview && <LoadingSpinner text={t('loadingPreview')} />}
            {preview.status === 'error' && (
              <Banner tone="red">
                <p>{t('previewFailed', { message: preview.message })}</p>
              </Banner>
            )}
            {preview.status === 'ready' && (
              <div className={stale ? 'opacity-60' : undefined}>
                {stale && (
                  <p role="status" className="mb-3 text-sm text-amber-700 dark:text-amber-400">
                    {t('stale')}
                  </p>
                )}
                <RuleRunPreviewTable preview={preview.preview} />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * "Run on existing transactions": previews what a saved rule would change over
 * the chosen accounts and dates, and commits that exact preview on confirm.
 * The run sends the preview's fingerprint; if the data moved since, the server
 * refuses and the dialog shows a new preview instead of writing anything.
 */
export function RunRuleDialog({ rule, accountOptions, onClose }: RunRuleDialogProps) {
  if (rule === null) return null;
  // Keyed by rule: opening it for another rule starts from a clean state.
  return <RunRuleBody key={rule.id} rule={rule} accountOptions={accountOptions} onClose={onClose} />;
}
