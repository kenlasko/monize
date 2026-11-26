'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/rules/RuleEditorBanners';
import { RuleRunSkippedList } from '@/components/rules/RuleRunPreviewTable';
import { useRuleRunErrorMessage } from '@/components/rules/use-rule-run-error';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateFormat } from '@/hooks/useDateFormat';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { loanBillAutoPostOf } from '@/components/rules/use-loan-bill-auto-post';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { Account } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { TransactionRule } from '@/types/transaction-rule';
import { LoanSettlementsTable, type LoanSettlementsState } from './LoanSettlementsTable';
import { PaymentMatchingCreateModal } from './PaymentMatchingCreateModal';
import {
  PROCESS_HISTORY_PAGE_LIMIT,
  processLoanHistory,
  type ProcessHistoryProgress,
  type ProcessHistoryResult,
} from './process-loan-history';

export type { LoanSettlementsState } from './LoanSettlementsTable';

interface PaymentMatchingPanelProps {
  account: Account;
  /** The page's settlements request, loaded with the loan history. */
  settlements: LoanSettlementsState;
  /** Reloads the loan (account, history, settlements) after the panel wrote something. */
  onChanged: () => void | Promise<void>;
}

type Lookup<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/**
 * One keyed read: the answer is adopted only for the key that asked for it,
 * so a loan switched mid-request never shows another loan's rule or bill.
 * `load` must be stable (a module-level function).
 */
function useKeyedLookup<T>(key: string | null, load: (key: string) => Promise<T>): [Lookup<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; attempt: number; ok: boolean; value?: T } | null>(null);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    load(key).then(
      (value) => {
        if (!cancelled) setAnswer({ key, attempt, ok: true, value });
      },
      () => {
        if (!cancelled) setAnswer({ key, attempt, ok: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, attempt, load]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  let lookup: Lookup<T> = { status: 'loading' };
  if (answer && answer.key === key && answer.attempt === attempt) {
    lookup = answer.ok ? { status: 'ready', value: answer.value as T } : { status: 'error' };
  }
  return [lookup, retry];
}

const loadRule = (id: string): Promise<TransactionRule> => transactionRulesApi.getById(id);
const loadSchedule = (id: string): Promise<ScheduledTransaction> => scheduledTransactionsApi.getById(id);

type ProcessState =
  | { status: 'idle' }
  | { status: 'running'; progress: ProcessHistoryProgress | null }
  | { status: 'finished'; result: ProcessHistoryResult };

/**
 * Loan Details' "Payment matching" panel
 * (`docs/specs/loan-installment-settlement.md` decision 6): the linked rule
 * or a dialog to create one, "Process history" over the bill's source
 * account, a warning while the bill still posts itself, the preconditions a
 * history run relies on (section 14.3), and the installments settled so far.
 */
export function PaymentMatchingPanel({ account, settlements, onChanged }: PaymentMatchingPanelProps) {
  const t = useTranslations('accounts.loanDetail.paymentMatching');
  const { formatDate } = useDateFormat();
  const errorMessage = useRuleRunErrorMessage();
  const ruleId = account.paymentMatchingRuleId ?? null;
  const scheduleId = account.scheduledTransactionId ?? null;
  const [rule, retryRule] = useKeyedLookup(ruleId, loadRule);
  const [schedule, retrySchedule] = useKeyedLookup(scheduleId, loadSchedule);
  const [creating, setCreating] = useState(false);
  const [process, setProcess] = useState<ProcessState>({ status: 'idle' });

  const running = process.status === 'running';
  const sourceAccountId = schedule.status === 'ready' ? schedule.value.accountId : null;
  const sourceAccountName = schedule.status === 'ready' ? (schedule.value.account?.name ?? null) : null;

  const processHistory = async () => {
    if (ruleId === null || sourceAccountId === null || running) return;
    setProcess({ status: 'running', progress: null });
    const result = await processLoanHistory(ruleId, sourceAccountId, (progress) =>
      setProcess({ status: 'running', progress }),
    );
    // A committed page moved money, and a request that failed may have
    // committed before its answer was lost, so the balances are dropped
    // whatever ended the loop.
    invalidateBalanceCaches();
    setProcess({ status: 'finished', result });
    retrySchedule();
    await onChanged();
  };

  const handleCreated = (created: TransactionRule) => {
    setCreating(false);
    toast.success(t('create.done', { name: created.name }));
    retrySchedule();
    void onChanged();
  };

  if (scheduleId === null) {
    return (
      <PanelCard title={t('title')} description={t('description')}>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('noSchedule')}</p>
      </PanelCard>
    );
  }

  let ruleLine;
  if (ruleId === null) {
    ruleLine = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('noRule')}</p>
        <Button size="sm" onClick={() => setCreating(true)} disabled={schedule.status !== 'ready'}>
          {t('createOne')}
        </Button>
      </div>
    );
  } else if (rule.status === 'loading') {
    ruleLine = <LoadingSpinner text={t('ruleLoading')} />;
  } else if (rule.status === 'error') {
    ruleLine = (
      <Banner tone="red" title={t('ruleFailed')}>
        <Button size="sm" variant="outline" onClick={retryRule}>
          {t('retry')}
        </Button>
      </Banner>
    );
  } else {
    ruleLine = (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('ruleLabel')}{' '}
        <Link href={`/rules/${rule.value.id}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
          {rule.value.name}
        </Link>
      </p>
    );
  }

  let scheduleLine = null;
  if (schedule.status === 'loading') scheduleLine = <LoadingSpinner text={t('scheduleLoading')} />;
  if (schedule.status === 'error') {
    scheduleLine = (
      <Banner tone="red" title={t('scheduleFailed')}>
        <Button size="sm" variant="outline" onClick={retrySchedule}>
          {t('retry')}
        </Button>
      </Banner>
    );
  }

  // What on the loan's bill posts itself, so the matched bank debit could pay
  // the same installment twice.
  const billAutoPost =
    ruleId !== null && schedule.status === 'ready' ? loanBillAutoPostOf(schedule.value) : null;

  return (
    <PanelCard title={t('title')} description={t('description')}>
      <div className="space-y-4">
        {ruleLine}
        {scheduleLine}
        {billAutoPost !== null && (
          <Banner tone="amber" title={t('autoPost.title')}>
            <p>{billAutoPost === 'bill' ? t('autoPost.body') : t('autoPost.bodyOccurrence')}</p>
          </Banner>
        )}

        {ruleId !== null && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={() => void processHistory()}
                isLoading={running}
                disabled={running || rule.status !== 'ready' || sourceAccountId === null}
              >
                {t('process.button')}
              </Button>
              {sourceAccountName && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('process.scope', { account: sourceAccountName })}
                </span>
              )}
            </div>
            {schedule.status === 'ready' && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-500 dark:text-gray-400">
                <li>{t('preconditions.openingBalance')}</li>
                <li>{t('preconditions.originalPrincipal')}</li>
                <li>{t('preconditions.scheduleStart', { date: formatDate(schedule.value.startDate) })}</li>
              </ul>
            )}
            <div aria-live="polite">
              {process.status === 'running' && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t('process.running', { count: process.progress?.settled ?? 0 })}
                </p>
              )}
              {process.status === 'finished' && (
                <ProcessOutcome result={process.result} failureMessage={errorMessage} />
              )}
            </div>
          </div>
        )}

        <LoanSettlementsTable
          settlements={settlements}
          currencyCode={account.currencyCode}
          onRetry={() => void onChanged()}
        />
      </div>

      {creating && (
        <PaymentMatchingCreateModal
          loanAccountId={account.id}
          institution={account.institution}
          sourceAccountName={sourceAccountName}
          onClose={() => setCreating(false)}
          onCreated={handleCreated}
        />
      )}
    </PanelCard>
  );
}

function PanelCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card padding="md">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mb-4 mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      {children}
    </Card>
  );
}

function ProcessOutcome({
  result,
  failureMessage,
}: {
  result: ProcessHistoryResult;
  failureMessage: (error: unknown, fallbackKey: 'runFailed') => string;
}) {
  const t = useTranslations('accounts.loanDetail.paymentMatching.process');
  const { formatDate } = useDateFormat();
  return (
    <div className="space-y-2">
      {result.status === 'failed' && (
        <Banner tone="red" title={t('failed')}>
          <p>{failureMessage(result.error, 'runFailed')}</p>
        </Banner>
      )}
      {result.status === 'stuck' && (
        <Banner tone="amber" title={t('stuckTitle')}>
          <p>
            {result.date !== null
              ? t('stuck', { date: formatDate(result.date), limit: PROCESS_HISTORY_PAGE_LIMIT })
              : t('stuckUnknown')}
          </p>
        </Banner>
      )}
      <p className="text-sm text-gray-900 dark:text-gray-100">{t('done', { count: result.settled })}</p>
      {result.settled > 0 && <p className="text-sm text-gray-600 dark:text-gray-300">{t('undo')}</p>}
      <RuleRunSkippedList skipped={result.skipped} />
    </div>
  );
}
