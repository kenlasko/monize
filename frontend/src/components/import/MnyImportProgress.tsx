'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { HelpLink } from '@/components/help/HelpLink';
import { MnyImportJob, MnyImportPhase } from '@/lib/import-mny';
import { mnyErrorDocsLink } from '@/lib/import-mny-error-docs';

interface MnyImportProgressProps {
  job: MnyImportJob | null;
  isStarting: boolean;
  onRetry: () => void;
  onStartOver: () => void;
}

/** The phases the backend reports, in the order it runs them. */
const PHASES: MnyImportPhase[] = [
  'preparing',
  'reference',
  'transactions',
  'investments',
  'bills',
  'prices',
  'finalizing',
  'verifying',
];

/** Error keys whose copy already says the rows are in the ledger. */
const COMMITTED_ERROR_KEYS = new Set([
  'mnyImportFailedAfterCommit',
  'mnyJobStalledAfterCommit',
]);

/**
 * The copy for a failed job. Once its rows committed, the server's state wins
 * over any generic key: "Nothing was saved" over a committed import invited a
 * second import of the file, which doubled every balance (A26-H08).
 */
function failedJobMessageKey(job: MnyImportJob): string {
  if (job.dataCommitted === true) {
    return job.errorKey && COMMITTED_ERROR_KEYS.has(job.errorKey)
      ? job.errorKey
      : 'mnyImportFailedAfterCommit';
  }
  return job.errorKey ? job.errorKey : 'mnyImportFailed';
}

/**
 * The import as it runs, and what to do when it does not.
 *
 * A 37,000-transaction file takes minutes, so the wizard shows which phase is
 * running and how far through it is. A failure offers Retry when the backend says
 * the job is retryable -- that reuses the staged file, so recovering from a killed
 * pod costs a click rather than another 200 MB upload.
 */
export function MnyImportProgress({
  job,
  isStarting,
  onRetry,
  onStartOver,
}: MnyImportProgressProps) {
  const t = useTranslations('import');

  if (job?.status === 'failed') {
    return (
      <div className="max-w-xl mx-auto">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">
            {t('mnyImporting.failedHeading')}
          </h2>
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            {t(`mnyErrors.${failedJobMessageKey(job)}`)}
          </p>
          <p className="mt-2 text-sm">
            <HelpLink
              link={mnyErrorDocsLink(failedJobMessageKey(job))}
              className="font-medium text-red-800 underline hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
            >
              {t('mnyImporting.learnMore')}
            </HelpLink>
          </p>
        </div>
        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={onStartOver}>
            {t('mnyImporting.startOver')}
          </Button>
          {job.retryable && (
            <Button onClick={onRetry} isLoading={isStarting}>
              {t('mnyImporting.retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const currentPhase = job?.progress?.phase ?? 'preparing';
  const currentIndex = PHASES.indexOf(currentPhase);
  const processed = job?.progress?.processed ?? 0;
  const total = job?.progress?.total ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <LoadingSpinner size="sm" fullContainer={false} />
          <h2 className="text-lg font-semibold text-foreground">
            {t('mnyImporting.heading')}
          </h2>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          {t('mnyImporting.doNotClose')}
        </p>

        <ol className="space-y-1 text-sm">
          {PHASES.map((phase, index) => {
            const state =
              index < currentIndex
                ? 'done'
                : index === currentIndex
                  ? 'active'
                  : 'pending';
            return (
              <li
                key={phase}
                className={
                  state === 'active'
                    ? 'font-medium text-foreground'
                    : state === 'done'
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/60'
                }
              >
                <span aria-hidden="true" className="mr-2">
                  {state === 'done' ? '✓' : state === 'active' ? '•' : '○'}
                </span>
                {t(`mnyImporting.phases.${phase}`)}
                {state === 'active' && total > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('mnyImporting.rowProgress', { processed, total })}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {total > 0 && (
          <div className="mt-4">
            <div
              className="h-2 w-full rounded bg-muted"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('mnyImporting.heading')}
            >
              <div
                className="h-2 rounded bg-primary transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
