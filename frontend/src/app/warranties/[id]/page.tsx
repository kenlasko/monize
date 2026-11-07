'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { transactionModalProps } from '@/components/transactions/transaction-modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { WarrantyClaimList } from '@/components/warranties/WarrantyClaimList';
import { WarrantyDetailCard } from '@/components/warranties/WarrantyDetailCard';
import { WarrantyDocumentsSection } from '@/components/warranties/WarrantyDocumentsSection';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { WarrantySummaryCards } from '@/components/warranties/WarrantySummaryCards';
import { WarrantySwitcher } from '@/components/warranties/WarrantySwitcher';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { invalidateCache } from '@/lib/apiCache';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { transactionsApi } from '@/lib/transactions';
import { isUuid } from '@/lib/uuid';
import { warrantiesApi } from '@/lib/warranties';
import { useAuthStore } from '@/store/authStore';
import type { Transaction } from '@/types/transaction';
import type { CreateWarrantyData, Warranty } from '@/types/warranty';

const WarrantyForm = dynamic(
  () => import('@/components/warranties/WarrantyForm').then((m) => m.WarrantyForm),
  { ssr: false },
);

// The register's own edit window, opened here for the linked purchase.
const TransactionForm = dynamic(
  () => import('@/components/transactions/TransactionForm').then((m) => m.TransactionForm),
  { ssr: false },
);

const logger = createLogger('WarrantyDetail');

export default function WarrantyDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <ProtectedRoute>
      {/* A route segment that is not an id names no warranty: nothing to
          fetch and nothing a retry could find, as the list page drops a
          malformed ?transactionId. Another id is another warranty: start its
          page from scratch. */}
      {isUuid(params.id) ? (
        <WarrantyDetailContent key={params.id} warrantyId={params.id} />
      ) : (
        <WarrantyNotFound />
      )}
    </ProtectedRoute>
  );
}

function WarrantyNotFound() {
  const t = useTranslations('warranties');
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <BackToWarranties />
        <div role="alert" className="py-12 text-center">
          <p className="text-sm text-gray-700 dark:text-gray-300">{t('detail.notFound')}</p>
        </div>
      </main>
    </PageLayout>
  );
}

function BackToWarranties() {
  const t = useTranslations('warranties');
  return (
    <Link
      href="/warranties"
      className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
      {t('detail.back')}
    </Link>
  );
}

/**
 * One warranty: its details, its documents, its claims and the purchase it
 * came from (docs/specs/warranty-tracker.md section 10).
 */
function WarrantyDetailContent({ warrantyId }: { warrantyId: string }) {
  const t = useTranslations('warranties');
  const tc = useTranslations('common');
  const tt = useTranslations('transactions');
  const router = useRouter();
  // An acting delegate reads the warranty, its documents and its claims; every
  // write is the owner's (design decision 9).
  const readOnly = useAuthStore((s) => s.actingAsUserId) !== null;

  // The warranty is held with the id it was read for; a reload keeps the one
  // on screen until the new answer lands.
  const [loaded, setLoaded] = useState<{ id: string; warranty: Warranty } | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const latestRequest = useRef(0);

  useEffect(() => {
    const request = ++latestRequest.current;
    warrantiesApi
      .getById(warrantyId)
      .then((result) => {
        if (latestRequest.current !== request) return;
        setLoaded({ id: warrantyId, warranty: result });
        setFailed(false);
      })
      .catch((error) => {
        if (latestRequest.current !== request) return;
        logger.error(error);
        setFailed(true);
      });
  }, [warrantyId, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  useOnUndoRedo(reload);
  useOnAiAction(reload);

  const {
    showForm,
    editingItem,
    openEdit,
    close,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<Warranty>();
  const purchaseModal = useFormModal<Transaction>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const warranty = loaded !== null && loaded.id === warrantyId ? loaded.warranty : null;

  // The caret beside the title offers the warranties listed beside this one:
  // the current list for a current warranty, the archived list for an
  // archived one. Read again on every reload, so a rename shows there too.
  const archivedState = warranty === null ? null : warranty.archivedAt !== null;
  const [siblings, setSiblings] = useState<{ archived: boolean; list: Warranty[] } | null>(null);
  useEffect(() => {
    if (archivedState === null) return;
    let cancelled = false;
    warrantiesApi
      .listAll({ archived: archivedState, sort: 'name', sortDir: 'asc' })
      .then((list) => {
        if (!cancelled) setSiblings({ archived: archivedState, list });
      })
      .catch((error) => {
        logger.warn('Failed to load the warranties for the switcher:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [archivedState, reloadToken]);
  const switcherWarranties = siblings !== null && siblings.archived === archivedState ? siblings.list : [];

  const handleFormSubmit = async (data: CreateWarrantyData): Promise<Warranty> => {
    try {
      const updated = await warrantiesApi.update(warrantyId, data);
      toast.success(t('page.toasts.updated'));
      return updated;
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.updateFailed')));
      throw error;
    }
  };

  const handleFormSuccess = () => {
    close();
    reload();
  };

  // The purchase opens in the register's edit window, loaded whole as the
  // register loads a row before editing it. A cash leg an investment owns is
  // edited from Investments, as the register sends it there.
  const handleEditPurchase = async (transactionId: string) => {
    let transaction: Transaction;
    try {
      transaction = await transactionsApi.getById(transactionId);
    } catch (error) {
      logger.error('Failed to load the linked purchase:', error);
      toast.error(t('detail.transaction.loadFailed'));
      return;
    }
    if (transaction.linkedInvestmentTransactionId) {
      toast(tt('page.toasts.investmentLinked'));
      router.push(`/investments?edit=${transaction.linkedInvestmentTransactionId}`);
      return;
    }
    purchaseModal.openEdit(transaction);
  };

  // A warranty listed in the purchase's form opens the way the register opens
  // one: the form closes through its own close path first, so a dirty form
  // asks before anything is lost and the closing modal's history step cannot
  // undo the navigation. This warranty's own entry just closes the form; the
  // page already shows it. A target a dirty form's dialog holds is released
  // by Discard or by a successful Save, and dropped by Keep editing.
  const pendingPurchaseNavigation = useRef<string | null>(null);
  const navigateAfterPurchaseCloses = (href: string | null) => {
    if (href !== null) window.setTimeout(() => router.push(href), 100);
  };
  const handleClosePurchase = () => {
    pendingPurchaseNavigation.current = null;
    purchaseModal.close();
  };
  const handleOpenWarrantyFromPurchase = (openedId: string) => {
    const href = openedId === warrantyId ? null : `/warranties/${openedId}`;
    if (purchaseModal.modalProps.onBeforeClose() === false) {
      pendingPurchaseNavigation.current = href;
      return;
    }
    handleClosePurchase();
    navigateAfterPurchaseCloses(href);
  };
  const releasePurchaseNavigation = () => {
    const href = pendingPurchaseNavigation.current;
    pendingPurchaseNavigation.current = null;
    navigateAfterPurchaseCloses(href);
  };

  // A saved purchase may have moved the payee, date or amount the warranty
  // shows, so the cached warranty reads go and the warranty is read again.
  const handlePurchaseSaved = () => {
    purchaseModal.close();
    invalidateCache('warranties:');
    reload();
    releasePurchaseNavigation();
  };

  const handleToggleArchive = async () => {
    if (!warranty) return;
    const archived = warranty.archivedAt !== null;
    setBusy(true);
    try {
      if (archived) {
        await warrantiesApi.unarchive(warrantyId);
        toast.success(t('page.toasts.unarchived'));
      } else {
        await warrantiesApi.archive(warrantyId);
        toast.success(t('page.toasts.archived'));
      }
      reload();
    } catch (error) {
      toast.error(
        getErrorMessage(error, archived ? t('page.toasts.unarchiveFailed') : t('page.toasts.archiveFailed')),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await warrantiesApi.delete(warrantyId);
      toast.success(t('page.toasts.deleted'));
      router.push('/warranties');
    } catch (error) {
      toast.error(getErrorMessage(error, t('page.toasts.deleteFailed')));
      setBusy(false);
    }
  };

  let content;
  if (warranty === null && failed) {
    content = (
      <div role="alert" className="py-12 text-center space-y-3">
        <p className="text-sm text-red-700 dark:text-red-300">{t('detail.loadFailed')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFailed(false);
            reload();
          }}
        >
          {t('detail.retry')}
        </Button>
      </div>
    );
  } else if (warranty === null) {
    content = <LoadingSpinner text={t('detail.loading')} />;
  } else {
    const archived = warranty.archivedAt !== null;
    content = (
      <>
        <PageHeader
          title={warranty.name}
          help="warranties"
          titleAdornment={
            <span className="inline-flex flex-wrap items-center gap-2">
              {/* Jump straight to another warranty instead of going back to
                  the list. */}
              <WarrantySwitcher
                currentId={warranty.id}
                warranties={switcherWarranties}
                onSelect={(id) => router.push(`/warranties/${id}`)}
              />
              <WarrantyStatusBadge warranty={warranty} />
              {archived && <Badge variant="gray">{t('detail.archivedBadge')}</Badge>}
            </span>
          }
          actions={
            readOnly ? undefined : (
              <>
                <Button variant="outline" size="md" disabled={busy} onClick={() => openEdit(warranty)}>
                  {tc('actions.edit')}
                </Button>
                <Button variant="outline" size="md" disabled={busy} onClick={handleToggleArchive}>
                  {archived ? t('list.actions.unarchive') : t('list.actions.archive')}
                </Button>
                <Button variant="outline" size="md" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  {tc('actions.delete')}
                </Button>
              </>
            )
          }
        />

        <div className="space-y-6">
          <WarrantySummaryCards warranty={warranty} />
          <WarrantyDetailCard warranty={warranty} onEditPurchase={readOnly ? undefined : handleEditPurchase} />
          <WarrantyDocumentsSection warrantyId={warranty.id} readOnly={readOnly} />
          <WarrantyClaimList warrantyId={warranty.id} today={warranty.today} onChanged={reload} readOnly={readOnly} />
        </div>

        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="2xl"
          padding="md"
          title={t('page.modal.editTitle')}
        >
          <WarrantyForm
            key={editingItem?.id ?? 'edit'}
            warranty={editingItem}
            onSubmit={handleFormSubmit}
            onSuccess={handleFormSuccess}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* The form's Warranties line links each warranty on this purchase;
            no Add warranty here, on a warranty's own page. */}
        <Modal
          isOpen={purchaseModal.showForm}
          onClose={handleClosePurchase}
          {...purchaseModal.modalProps}
          {...transactionModalProps}
          title={tt('page.editModal.editTitle')}
        >
          {purchaseModal.showForm && purchaseModal.editingItem && (
            <TransactionForm
              transaction={purchaseModal.editingItem}
              onSuccess={handlePurchaseSaved}
              onCancel={handleClosePurchase}
              onDirtyChange={purchaseModal.setFormDirty}
              submitRef={purchaseModal.formSubmitRef}
              onOpenWarranty={readOnly ? undefined : handleOpenWarrantyFromPurchase}
            />
          )}
        </Modal>
        <UnsavedChangesDialog
          {...purchaseModal.unsavedChangesDialog}
          onDiscard={() => {
            purchaseModal.unsavedChangesDialog.onDiscard();
            releasePurchaseNavigation();
          }}
          onCancel={() => {
            pendingPurchaseNavigation.current = null;
            purchaseModal.unsavedChangesDialog.onCancel();
          }}
        />

        <ConfirmDialog
          isOpen={confirmDelete}
          title={t('page.delete.title')}
          message={t('page.delete.message', { name: warranty.name })}
          confirmLabel={tc('actions.delete')}
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      </>
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <BackToWarranties />
        {content}
      </main>
    </PageLayout>
  );
}
