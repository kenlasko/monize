'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon, InboxIcon } from '@heroicons/react/24/outline';
import { AiReviewRow } from '@/components/ai-review/AiReviewRow';
import { SendPendingToAssistantButton } from '@/components/ai-review/SendPendingToAssistantButton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { TABLE_BODY_CLASS, TABLE_CLASS, Th } from '@/components/ui/Table';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { itemsOfKind, useAiReviewInbox } from '@/hooks/useAiReviewInbox';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import {
  AI_REVIEW_KIND_FILTERS,
  AI_REVIEW_STATUSES,
  parseKindFilter,
  reviewItemLabel,
  type AiReviewFilter,
  type AiReviewItem,
  type AiReviewKindFilter,
} from '@/types/ai-review';

const FILTERS: readonly AiReviewFilter[] = ['open', ...AI_REVIEW_STATUSES];

/**
 * The review inbox: the requests rules (and, later, the user) have queued for
 * an AI, filtered by status. `items === null` is loading or failed, never an
 * empty list; only a loaded, empty answer shows the explanation.
 *
 * The kind segments count the loaded list (each says how many rows it shows);
 * the status segments carry no count, since the server answers one status per
 * request. No column sorts: the server answers the newest requests first, a
 * bounded number of them, so a sort of that answer would rank a partial list.
 * Density is the inbox's own (`aiReviews`); on a phone at Normal density each
 * request is one card cell, as the reference lists do.
 */
export function AiReviewInbox() {
  const t = useTranslations('aiReview');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    filter,
    setFilter,
    kind,
    setKind,
    shownItems,
    approvable,
    selected,
    sendable,
    selectedSendable,
    toggleSelected,
    clearSelection,
    batching,
    summary,
    clearSummary,
    approveBatch,
    items,
    loadFailed,
    retry,
    cards,
    dismissing,
    approve,
    dismiss,
  } = useAiReviewInbox(parseKindFilter(searchParams.get('kind')));
  const { formatNumber } = useNumberFormat();
  const { density } = useDensityPreference('aiReviews');
  const { headerPadding } = useTableDensity(density);
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';
  const [dismissTarget, setDismissTarget] = useState<AiReviewItem | null>(null);
  const [bulkTarget, setBulkTarget] = useState<readonly AiReviewItem[] | null>(null);

  // The kind filter lives in the URL (?kind=) so a link, a reload and the back button keep it.
  const chooseKind = (next: AiReviewKindFilter) => {
    setKind(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'all') params.delete('kind');
    else params.set('kind', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const confirmBulk = () => {
    const target = bulkTarget;
    setBulkTarget(null);
    if (target) void approveBatch(target);
  };

  // One column of checkboxes serves both bulk actions: approving proposals and sending pending requests.
  const checkable = [...approvable, ...sendable];
  const checked = [...selected, ...selectedSendable];
  const allSelected = checkable.length > 0 && checked.length === checkable.length;
  const toggleAll = () => {
    if (allSelected) clearSelection();
    else checkable.filter((item) => !checked.includes(item)).forEach((item) => toggleSelected(item.id));
  };
  const selectable = checkable.length > 0;
  const nameOf = (id: string) => {
    const item = items?.find((candidate) => candidate.id === id);
    return (item ? reviewItemLabel(item) : null) ?? t('bulk.unknownRequest');
  };

  // How many loaded rows each kind segment shows; no number while the list is loading or failed.
  const kindLabel = (option: AiReviewKindFilter) => {
    const label = t(`kindFilter.${option}`);
    if (items === null) return label;
    return t('kindFilter.option', { label, count: formatNumber(itemsOfKind(items, option).length, 0) });
  };

  const confirmDismiss = () => {
    const target = dismissTarget;
    setDismissTarget(null);
    if (target) void dismiss(target);
  };

  let body;
  if (items === null && loadFailed) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={<Button onClick={retry}>{t('error.retry')}</Button>}
        />
      </div>
    );
  } else if (shownItems === null) {
    body = <LoadingSpinner text={t('loading')} />;
  } else if (shownItems.length === 0) {
    const narrowed = kind !== 'all' || filter !== 'open';
    body = (
      <EmptyState
        icon={<InboxIcon />}
        title={narrowed ? t('empty.filteredTitle') : t('empty.title')}
        description={narrowed ? t('empty.filteredBody') : t('empty.body')}
      />
    );
  } else {
    const selectAllBox = (
      <input
        type="checkbox"
        checked={allSelected}
        onChange={toggleAll}
        aria-label={t('bulk.selectAll')}
        className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-600"
      />
    );
    body = (
      <div>
        <DensityToggleBar view="aiReviews" />
        <div className="overflow-x-auto">
          <table className={`${TABLE_CLASS} ui-docket`}>
            <thead>
              <tr>
                {selectable && <Th className={`${headerPadding} w-10`}>{selectAllBox}</Th>}
                {wrapped ? (
                  <Th className={headerPadding}>{t('columns.request')}</Th>
                ) : (
                  <>
                    <Th className={headerPadding}>{t('columns.date')}</Th>
                    <Th className={headerPadding}>{t('columns.request')}</Th>
                    <Th align="right" className={headerPadding}>
                      {t('columns.amount')}
                    </Th>
                    <Th className={headerPadding}>{t('columns.status')}</Th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {shownItems.map((item) => (
                <AiReviewRow
                  key={item.id}
                  item={item}
                  card={cards[item.id]}
                  dismissing={dismissing.has(item.id)}
                  selectable={selectable}
                  selected={checked.includes(item)}
                  onToggleSelected={(row) => toggleSelected(row.id)}
                  onApprove={approve}
                  onDismiss={setDismissTarget}
                  density={density}
                  wrapped={wrapped}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" {...tourAnchor(TOUR_ANCHORS.aiReviewInbox)}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('filter.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={segmentClass(filter === option)}
            >
              {t(`filter.${option}`)}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t('kindFilter.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
          {AI_REVIEW_KIND_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => chooseKind(option)}
              className={segmentClass(kind === option)}
            >
              {kindLabel(option)}
            </button>
          ))}
        </div>
        <div className="sm:ml-auto">
          <SendPendingToAssistantButton pending={sendable} selected={selectedSendable} />
        </div>
      </div>
      {approvable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => setBulkTarget(selected)}
            disabled={selected.length === 0 || batching}
            isLoading={batching}
          >
            {t('bulk.approveSelected', { count: selected.length })}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulkTarget(approvable)} disabled={batching}>
            {t('bulk.approveAllShown', { count: approvable.length })}
          </Button>
        </div>
      )}
      {summary && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 ${
            summary.failed > 0
              ? 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-900/20'
              : 'border-green-200 bg-green-50 dark:border-green-900/60 dark:bg-green-900/20'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('bulk.summary', { approved: summary.approved, failed: summary.failed })}
            </p>
            <Button variant="outline" size="sm" onClick={clearSummary}>
              {t('bulk.closeSummary')}
            </Button>
          </div>
          {summary.failures.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
              {summary.failures.map((failure) => (
                <li key={failure.id}>{t('bulk.failure', { name: nameOf(failure.id), reason: failure.error ?? t('bulk.noReason') })}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Card>{body}</Card>
      <ConfirmDialog
        isOpen={bulkTarget !== null}
        title={t('bulk.dialog.title', { count: bulkTarget?.length ?? 0 })}
        message={t('bulk.dialog.message')}
        confirmLabel={t('bulk.dialog.confirm', { count: bulkTarget?.length ?? 0 })}
        variant="warning"
        onConfirm={confirmBulk}
        onCancel={() => setBulkTarget(null)}
      />
      <ConfirmDialog
        isOpen={dismissTarget !== null}
        title={t('dismissDialog.title')}
        message={t('dismissDialog.message')}
        confirmLabel={t('dismissDialog.confirm')}
        variant="warning"
        onConfirm={confirmDismiss}
        onCancel={() => setDismissTarget(null)}
      />
    </div>
  );
}
