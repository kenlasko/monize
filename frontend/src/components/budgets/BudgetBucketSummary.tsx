'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { BudgetProgressBar } from './BudgetProgressBar';
import type { BudgetBucketStatus, BudgetBucketStatusResult } from '@/types/budget';

/** The status request's three honest states; a failure is never an empty result. */
export type BudgetBucketStatusState =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; data: BudgetBucketStatusResult };

interface BudgetBucketSummaryProps {
  budgetId: string;
  status: BudgetBucketStatusState;
  formatCurrency: (amount: number) => string;
}

const LINK_CLASS =
  'text-blue-600 hover:underline dark:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded';

/**
 * Renders the server's bucket figures (INV-BUDGET-001): nothing here adds,
 * subtracts or divides a bucket figure, it only formats what it is given.
 */
export function BudgetBucketSummary({
  budgetId,
  status,
  formatCurrency,
}: BudgetBucketSummaryProps) {
  const t = useTranslations('budgets');
  const editHref = `/budgets/${budgetId}/edit`;

  return (
    <Card padding="md" as="section" aria-labelledby="bucket-summary-title">
      <h3
        id="bucket-summary-title"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4"
      >
        {t('bucketSummary.title')}
      </h3>
      {status.state === 'loading' && (
        <div role="status" aria-label={t('bucketSummary.loading')}>
          <LoadingSpinner />
        </div>
      )}
      {status.state === 'error' && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('bucketSummary.loadFailed')}
        </p>
      )}
      {status.state === 'ready' && (
        <BucketSummaryBody
          data={status.data}
          editHref={editHref}
          formatCurrency={formatCurrency}
        />
      )}
    </Card>
  );
}

function BucketSummaryBody({
  data,
  editHref,
  formatCurrency,
}: {
  data: BudgetBucketStatusResult;
  editHref: string;
  formatCurrency: (amount: number) => string;
}) {
  const t = useTranslations('budgets');

  if (data.buckets.length === 0) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-400">
        <p>{t('bucketSummary.emptyDescription')}</p>
        <Link href={editHref} className={`${LINK_CLASS} inline-block mt-2`}>
          {t('bucketSummary.emptyAction')}
        </Link>
      </div>
    );
  }

  const partialTotal = data.totalAllocated === null;
  const overAllocated = data.unallocated !== null && data.unallocated < 0;

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('bucketSummary.income')}</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {data.income === null
              ? t('bucketSummary.incomeUnknown')
              : formatCurrency(data.income)}
          </dd>
          <dd className="text-xs text-gray-500 dark:text-gray-400">
            {t(`bucketSummary.incomeSource.${data.incomeSource}`)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">
            {partialTotal ? t('bucketSummary.allocatedSoFar') : t('bucketSummary.totalAllocated')}
          </dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">
            {formatCurrency(partialTotal ? data.knownAllocated : (data.totalAllocated as number))}
          </dd>
          {partialTotal && (
            <dd className="text-xs text-gray-500 dark:text-gray-400">
              {t('bucketSummary.allocatedSoFarHint')}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t('bucketSummary.unallocated')}</dt>
          <dd
            className={`font-medium ${
              overAllocated
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {data.unallocated === null
              ? t('bucketSummary.unallocatedUnknown')
              : formatCurrency(data.unallocated)}
          </dd>
          {overAllocated && (
            <dd role="alert" className="text-xs text-red-600 dark:text-red-400">
              {t('bucketSummary.overAllocatedHint')}
            </dd>
          )}
        </div>
      </dl>

      <ul className="space-y-4">
        {data.buckets.map((bucket) => (
          <BucketRow
            key={bucket.bucketId}
            bucket={bucket}
            editHref={editHref}
            formatCurrency={formatCurrency}
          />
        ))}
      </ul>

      {data.unassigned.lineCount > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('bucketSummary.unassignedTitle')}
            </span>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {t('bucketSummary.unassignedPlanned')} {formatCurrency(data.unassigned.planned)}
              {' / '}
              {t('bucketSummary.spent')} {formatCurrency(data.unassigned.spent)}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t('bucketSummary.unassignedDescription', { count: data.unassigned.lineCount })}{' '}
            <Link href={editHref} className={LINK_CLASS}>
              {t('bucketSummary.unassignedAction')}
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}

function BucketRow({
  bucket,
  editHref,
  formatCurrency,
}: {
  bucket: BudgetBucketStatus;
  editHref: string;
  formatCurrency: (amount: number) => string;
}) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();

  const target =
    bucket.targetType === 'PERCENT'
      ? t('bucketSummary.targetPercent', { percent: formatPercentTrimmed(bucket.targetValue) })
      : t('bucketSummary.targetAmount', { amount: formatCurrency(bucket.targetValue) });

  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 mb-1">
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {bucket.name}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{target}</span>
      </div>
      {bucket.carriedIn !== 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
          {t('bucketSummary.carriedIn', { amount: formatCurrency(bucket.carriedIn) })}
        </div>
      )}
      {bucket.allocated === null || bucket.available === null || bucket.percentUsed === null ? (
        <>
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t('bucketSummary.allocationUnknown')}{' '}
            <Link href={editHref} className={LINK_CLASS}>
              {t('bucketSummary.allocationUnknownAction')}
            </Link>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-3 mt-1 text-xs text-gray-600 dark:text-gray-400">
            <span>
              {t('bucketSummary.spent')} {formatCurrency(bucket.spent)}
            </span>
            <span>{t('bucketSummary.categories', { count: bucket.lineCount })}</span>
          </div>
        </>
      ) : (
        <>
          <BudgetProgressBar percentUsed={bucket.percentUsed} />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 mt-1 text-xs">
            <span className="text-gray-600 dark:text-gray-400">
              {t('bucketSummary.spent')} {formatCurrency(bucket.spent)}
            </span>
            <span
              className={
                bucket.available < 0
                  ? 'font-medium text-red-600 dark:text-red-400'
                  : 'text-gray-600 dark:text-gray-400'
              }
            >
              {bucket.available < 0 ? t('bucketSummary.overspent') : t('bucketSummary.available')}{' '}
              {formatCurrency(bucket.available)}
            </span>
            <span className="text-gray-500 dark:text-gray-400">
              {t('bucketSummary.categories', { count: bucket.lineCount })}
            </span>
          </div>
        </>
      )}
    </li>
  );
}
