'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ArrowDownTrayIcon, ArrowUpTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import { LIST_TOOLBAR_BUTTON_CLASS } from '@/components/ui/ListTopToolbar';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { WarrantyImportDialog } from '@/components/warranties/WarrantyImportDialog';
import { DEFAULT_SORT_DIRECTION, WarrantyList } from '@/components/warranties/WarrantyList';
import { exportWarrantiesCsv } from '@/components/warranties/warranty-csv-export';
import type { WarrantyPrefill } from '@/components/warranties/WarrantyForm';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFormModal } from '@/hooks/useFormModal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { PAGE_SIZE } from '@/lib/constants';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { transactionsApi } from '@/lib/transactions';
import { isUuid } from '@/lib/uuid';
import { warrantiesApi } from '@/lib/warranties';
import { useAuthStore } from '@/store/authStore';
import type {
  CreateWarrantyData,
  Warranty,
  WarrantyListResult,
  WarrantySort,
  WarrantySortDir,
  WarrantyStatusFilter,
  WarrantySummary,
} from '@/types/warranty';
import { docsUrl } from '@/lib/docs-links';

const WarrantyForm = dynamic(
  () => import('@/components/warranties/WarrantyForm').then((m) => m.WarrantyForm),
  { ssr: false },
);

const logger = createLogger('Warranties');

const STATUS_FILTERS: readonly WarrantyStatusFilter[] = ['all', 'expiring', 'active', 'expired', 'lifetime'];

export default function WarrantiesPage() {
  return (
    <ProtectedRoute>
      {/* The page reads ?new= and ?transactionId= through useSearchParams. */}
      <Suspense fallback={null}>
        <WarrantiesContent />
      </Suspense>
    </ProtectedRoute>
  );
}

function WarrantiesContent() {
  const t = useTranslations('warranties');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { formatNumber } = useNumberFormat();
  // An acting delegate reads warranties; every write is the owner's.
  const readOnly = useAuthStore((s) => s.actingAsUserId) !== null;

  const urlTransactionParam = searchParams.get('transactionId');
  const urlTransactionId = isUuid(urlTransactionParam) ? urlTransactionParam : null;
  const urlNew = searchParams.get('new') === '1';

  const [status, setStatus] = useState<WarrantyStatusFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const q = useDebouncedValue(searchInput.trim(), 300);
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<WarrantySort>('expiresOn');
  const [sortDir, setSortDir] = useState<WarrantySortDir>(DEFAULT_SORT_DIRECTION.expiresOn);
  const [page, setPage] = useState(1);
  const [transactionFilter, setTransactionFilter] = useState<string | null>(urlTransactionId);

  // A new link (or the chip being dismissed by navigation) replaces the filter.
  const [syncedUrlTransactionId, setSyncedUrlTransactionId] = useState(urlTransactionId);
  if (syncedUrlTransactionId !== urlTransactionId) {
    setSyncedUrlTransactionId(urlTransactionId);
    setTransactionFilter(urlTransactionId);
    setPage(1);
  }
  // A settled search starts again from the first page.
  const [pagedQuery, setPagedQuery] = useState(q);
  if (pagedQuery !== q) {
    setPagedQuery(q);
    setPage(1);
  }

  // The request key is every selector that changes what the list means.
  const params = useMemo(
    () => ({
      status,
      q: q || undefined,
      archived,
      sort,
      sortDir,
      page,
      limit: PAGE_SIZE,
      transactionId: transactionFilter ?? undefined,
    }),
    [status, q, archived, sort, sortDir, page, transactionFilter],
  );
  const requestKey = JSON.stringify(params);
  const [list, setList] = useState<{ key: string; result: WarrantyListResult } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // `null` is a summary still loading; a failed one is `summaryFailed`.
  const [summary, setSummary] = useState<WarrantySummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [summaryRetry, setSummaryRetry] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const latestRequest = useRef(0);
  const latestSummaryRequest = useRef(0);

  useEffect(() => {
    const request = ++latestRequest.current;
    warrantiesApi
      .list(params)
      .then((result) => {
        // Only the newest request's answer lands: a slow answer to a filter
        // the reader has already left must not replace the current one.
        if (latestRequest.current !== request) return;
        setList({ key: requestKey, result });
        setFailedKey(null);
      })
      .catch((error) => {
        if (latestRequest.current !== request) return;
        logger.error(error);
        setFailedKey(requestKey);
      });
  }, [params, requestKey, reloadToken]);

  useEffect(() => {
    const request = ++latestSummaryRequest.current;
    warrantiesApi
      .summary()
      .then((result) => {
        // Same rule as the list: a slow answer to an earlier reload must not
        // replace the counts a later one already brought.
        if (latestSummaryRequest.current !== request) return;
        setSummary(result);
        setSummaryFailed(false);
      })
      .catch((error) => {
        if (latestSummaryRequest.current !== request) return;
        logger.error(error);
        setSummaryFailed(true);
      });
  }, [reloadToken, summaryRetry]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  useOnUndoRedo(reload);
  useOnAiAction(reload);

  const {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Warranty>();
  const [prefill, setPrefill] = useState<WarrantyPrefill | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Warranty | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // The export is every warranty the current filter matches, fetched page by
  // page: the page holds only the rows on screen.
  const handleExport = async () => {
    setExporting(true);
    try {
      const rows = await warrantiesApi.listAll({
        status,
        q: q || undefined,
        archived,
        sort,
        sortDir,
        transactionId: transactionFilter ?? undefined,
      });
      const today = rows[0]?.today;
      exportWarrantiesCsv(rows, today ? `warranties-${today}` : 'warranties');
      toast.success(t('page.toasts.exported', { count: rows.length, shown: formatNumber(rows.length, 0) }));
    } catch (error) {
      logger.error(error);
      toast.error(getErrorMessage(error, t('page.toasts.exportFailed')));
    } finally {
      setExporting(false);
    }
  };

  const openNew = useCallback(() => {
    setPrefill(undefined);
    openCreate();
  }, [openCreate]);

  // `?new=1&transactionId=<id>`: open the form filled from that purchase, once
  // per link, then leave the list filtered to it.
  const handledNewFor = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !urlNew || urlTransactionId === null || handledNewFor.current === urlTransactionId) return;
    const id = urlTransactionId;
    handledNewFor.current = id;
    transactionsApi
      .getById(id)
      .then((tx) => {
        setPrefill({
          name: tx.payeeName || tx.payee?.name || tx.description || '',
          vendorName: tx.payee?.name ?? tx.payeeName ?? null,
          payeeId: tx.payeeId,
          transactionId: tx.id,
          purchaseDate: tx.transactionDate,
          // The API sends a decimal as a string; a price is never negative.
          purchasePrice: Math.abs(Number(tx.amount)),
          currencyCode: tx.currencyCode,
        });
        openCreate();
      })
      .catch((error) => {
        logger.error(error);
        toast.error(t('page.toasts.prefillFailed'));
        setPrefill(undefined);
        openCreate();
      })
      .finally(() => router.replace(`/warranties?transactionId=${id}`));
  }, [readOnly, urlNew, urlTransactionId, openCreate, router, t]);

  // Save only: the form uploads a new warranty's staged documents to the row
  // this resolves with, then calls handleFormSuccess.
  const handleFormSubmit = async (data: CreateWarrantyData): Promise<Warranty> => {
    try {
      if (editingItem) {
        const updated = await warrantiesApi.update(editingItem.id, data);
        toast.success(t('page.toasts.updated'));
        return updated;
      }
      const created = await warrantiesApi.create(data);
      toast.success(t('page.toasts.created'));
      return created;
    } catch (error) {
      toast.error(getErrorMessage(error, editingItem ? t('page.toasts.updateFailed') : t('page.toasts.createFailed')));
      throw error;
    }
  };

  const handleFormSuccess = () => {
    close();
    reload();
  };

  const openDetail = useCallback(
    (warranty: Warranty) => router.push(`/warranties/${warranty.id}`),
    [router],
  );

  const handleArchive = useCallback(
    async (warranty: Warranty) => {
      try {
        await warrantiesApi.archive(warranty.id);
        toast.success(t('page.toasts.archived'));
        reload();
      } catch (error) {
        toast.error(getErrorMessage(error, t('page.toasts.archiveFailed')));
      }
    },
    [reload, t],
  );

  const handleUnarchive = useCallback(
    async (warranty: Warranty) => {
      try {
        await warrantiesApi.unarchive(warranty.id);
        toast.success(t('page.toasts.unarchived'));
        reload();
      } catch (error) {
        toast.error(getErrorMessage(error, t('page.toasts.unarchiveFailed')));
      }
    },
    [reload, t],
  );

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await warrantiesApi.delete(deleteTarget.id);
      toast.success(t('page.toasts.deleted'));
      reload();
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.deleteFailed')));
    } finally {
      setDeleteTarget(null);
    }
  };

  const changeStatus = (next: WarrantyStatusFilter) => {
    setStatus(next);
    setPage(1);
  };

  const clearTransactionFilter = () => {
    setTransactionFilter(null);
    setPage(1);
    router.replace('/warranties');
  };

  const summaryLoading = summary === null && !summaryFailed;
  // Failed reads "Not loaded" (with a retry under the strip); still loading is
  // a placeholder, never a figure.
  const summaryValue = (count: number | undefined) => {
    if (summaryFailed) return t('page.summary.unavailable');
    if (count === undefined) return <Skeleton className="h-6 w-10" />;
    return formatNumber(count, 0);
  };

  // The summary counts the current (unarchived) warranties, so a segment
  // carries its count only over that list, once the counts have arrived.
  const filterCount = (option: WarrantyStatusFilter): number | null => {
    if (archived || summary === null || summaryFailed) return null;
    return option === 'all' ? summary.total : summary.counts[option];
  };

  const filtered = status !== 'all' || q !== '' || transactionFilter !== null;
  const empty = useMemo(() => {
    if (archived) return { title: t('page.empty.archivedTitle') };
    if (filtered) return { title: t('page.empty.filteredTitle'), description: t('page.empty.filteredDescription') };
    return {
      title: t('page.empty.title'),
      description: t('page.empty.description'),
      action: readOnly ? undefined : <Button onClick={openNew}>{t('page.newButton')}</Button>,
    };
  }, [archived, filtered, openNew, readOnly, t]);

  const isStale = list !== null && list.key !== requestKey;
  const failed = failedKey === requestKey;
  const pagination = list?.result.pagination;

  let body;
  if (failed) {
    body = (
      <div role="alert" className="p-6 text-center space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{t('page.loadFailed')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFailedKey(null);
            reload();
          }}
        >
          {t('page.retry')}
        </Button>
      </div>
    );
  } else if (list === null) {
    body = <LoadingSpinner text={t('page.loading')} />;
  } else {
    body = (
      <WarrantyList
        warranties={list.result.data}
        sort={sort}
        sortDir={sortDir}
        onSort={(next) => {
          // The active column flips; a new one starts in its own natural direction.
          setSortDir(next === sort ? (sortDir === 'asc' ? 'desc' : 'asc') : DEFAULT_SORT_DIRECTION[next]);
          setSort(next);
          setPage(1);
        }}
        empty={empty}
        stale={isStale}
        readOnly={readOnly}
        toolbarActions={
          <>
            {/* A read, so a delegate exports too; importing is the owner's. */}
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting || pagination?.total === 0}
              className={`${LIST_TOOLBAR_BUTTON_CLASS} gap-1`}
            >
              <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
              {t('page.exportButton')}
            </button>
            {readOnly ? undefined : (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className={`${LIST_TOOLBAR_BUTTON_CLASS} gap-1`}
                {...tourAnchor(TOUR_ANCHORS.warrantiesImportButton)}
              >
                <ArrowUpTrayIcon className="h-4 w-4" aria-hidden="true" />
                {t('page.importButton')}
              </button>
            )}
          </>
        }
        onOpen={openDetail}
        onEdit={openEdit}
        onArchive={handleArchive}
        onUnarchive={handleUnarchive}
        onDelete={setDeleteTarget}
        currentPage={pagination?.page}
        totalPages={pagination?.totalPages}
        totalItems={pagination?.total}
        pageSize={pagination?.limit}
        onPageChange={setPage}
      />
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('warranties')}
          actions={
            readOnly ? undefined : (
              // The screen's one primary action; adding is the owner's.
              <Button onClick={openNew} {...tourAnchor(TOUR_ANCHORS.warrantiesAddButton)}>
                {t('page.newButton')}
              </Button>
            )
          }
        />

        <div
          className={`grid grid-cols-2 md:grid-cols-4 gap-4 ${summaryFailed ? 'mb-3' : 'mb-6'}`}
          aria-busy={summaryLoading}
          data-testid="warranty-summary"
          {...tourAnchor(TOUR_ANCHORS.warrantiesSummary)}
        >
          <SummaryCard
            label={t('page.summary.expiring')}
            value={summaryValue(summary?.counts.expiring)}
            hint={summary && !summaryFailed ? t('page.summary.expiringHint', { days: formatNumber(summary.windowDays, 0) }) : undefined}
            icon={SummaryIcons.clock}
            valueColor="yellow"
            onClick={() => changeStatus('expiring')}
          />
          <SummaryCard
            label={t('page.summary.active')}
            value={summaryValue(summary?.counts.active)}
            icon={SummaryIcons.checkCircle}
            valueColor="green"
            onClick={() => changeStatus('active')}
          />
          <SummaryCard
            label={t('page.summary.expired')}
            value={summaryValue(summary?.counts.expired)}
            icon={SummaryIcons.ban}
            valueColor="red"
            onClick={() => changeStatus('expired')}
          />
          <SummaryCard
            label={t('page.summary.lifetime')}
            value={summaryValue(summary?.counts.lifetime)}
            icon={SummaryIcons.checkmark}
            valueColor="blue"
            onClick={() => changeStatus('lifetime')}
          />
        </div>
        {summaryFailed && (
          <div className="mb-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSummaryFailed(false);
                setSummaryRetry((n) => n + 1);
              }}
            >
              {t('page.retry')}
            </Button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="w-full sm:w-auto sm:min-w-[30rem]">
            <Input
              type="search"
              aria-label={t('page.search.label')}
              placeholder={t('page.search.placeholder')}
              value={searchInput}
              maxLength={200}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div role="group" aria-label={t('page.filters.label')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
            {STATUS_FILTERS.map((option) => {
              const count = filterCount(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={status === option}
                  onClick={() => changeStatus(option)}
                  className={`${toolbarSegmentClass(status === option)} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
                >
                  {count === null
                    ? t(`page.filters.${option}`)
                    : t(`page.filters.counted.${option}`, { count: formatNumber(count, 0) })}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 sm:ml-auto">
            <ToggleSwitch
              checked={archived}
              onChange={(next) => {
                setArchived(next);
                setPage(1);
              }}
              label={t('page.archivedToggle')}
            />
            <span aria-hidden="true">{t('page.archivedToggle')}</span>
          </label>
        </div>

        {transactionFilter !== null && (
          <div className="mb-4 inline-flex items-center gap-1">
            <Badge variant="blue" size="md">
              {t('page.transactionChip.label')}
            </Badge>
            <button
              type="button"
              onClick={clearTransactionFilter}
              aria-label={t('page.transactionChip.clear')}
              title={t('page.transactionChip.clear')}
              className="rounded p-1 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        <Card className="overflow-hidden">{body}</Card>

        {pagination && !failed && (
          <ListBottomPager
            currentPage={pagination.page}
            totalPages={pagination.totalPages}
            totalItems={pagination.total}
            pageSize={pagination.limit}
            onPageChange={setPage}
            itemName={t('page.pager.itemName')}
            totalLabel={t('page.pager.total', { count: pagination.total, total: formatNumber(pagination.total, 0) })}
          />
        )}

        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="2xl"
          padding="md"
          title={isEditing ? t('page.modal.editTitle') : t('page.modal.newTitle')}
        >
          <WarrantyForm
            key={editingItem?.id ?? prefill?.transactionId ?? 'new'}
            warranty={editingItem}
            prefill={prefill}
            onSubmit={handleFormSubmit}
            onSuccess={handleFormSuccess}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {!readOnly && (
          <WarrantyImportDialog
            isOpen={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={() => {
              setImportOpen(false);
              reload();
            }}
          />
        )}

        <ConfirmDialog
          isOpen={deleteTarget !== null}
          title={t('page.delete.title')}
          message={t('page.delete.message', { name: deleteTarget?.name ?? '' })}
          confirmLabel={tc('actions.delete')}
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      </main>
    </PageLayout>
  );
}
