'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { InboxArrowDownIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useAuthStore } from '@/store/authStore';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { transactionModalProps } from '@/components/transactions/transaction-modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SharedFileList } from '@/components/share/SharedFileList';
import { ShareDestinations } from '@/components/share/ShareDestinations';
import {
  discardSharedBundle,
  isShareInboxSupported,
  listSharedBundles,
  readSharedBundle,
  type SharedBundle,
} from '@/lib/share-inbox';
import { isShareBundleId } from '@/lib/share-target';
import { assistantAcceptsFiles } from '@/lib/ai-attachments';
import { useAiConfigured } from '@/hooks/useAiConfigured';
import { createLogger } from '@/lib/logger';

const TransactionForm = dynamic(
  () =>
    import('@/components/transactions/TransactionForm').then(
      (m) => m.TransactionForm,
    ),
  { ssr: false },
);

const logger = createLogger('Share');

/**
 * What the review screen is showing. Every one of these is a state the user can
 * actually reach, and each says something different about what happened -- the
 * point of the screen is that a share never dead-ends on a browser error page.
 */
type ReviewState =
  | 'loading'
  | 'unsupportedBrowser'
  | 'missed'
  | 'error'
  | 'notFound'
  | 'expired'
  | 'empty'
  | 'none'
  | 'mixed'
  | 'ready';

export default function SharePage() {
  return (
    <ProtectedRoute>
      {/* useSearchParams needs a boundary; the shell renders instantly and the
          bundle read is what takes a moment. */}
      <Suspense fallback={<ShareFallback />}>
        <ShareContent />
      </Suspense>
    </ProtectedRoute>
  );
}

function ShareFallback() {
  return (
    <PageLayout>
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    </PageLayout>
  );
}

function ShareContent() {
  const t = useTranslations('share');
  const router = useRouter();
  const searchParams = useSearchParams();

  // Whose share this is. A bundle belongs to the first authenticated reader
  // that sees it, so nothing is read before the reader is known -- an unknown
  // viewer must not be shown, or be able to claim, anybody's share.
  const viewerUserId = useAuthStore((state) => state.user?.id);

  // Whether the assistant is a destination at all. A provider that cannot
  // answer means no row: a button whose only outcome is "configure a provider
  // first" is not a destination.
  const { configured: aiConfigured } = useAiConfigured();

  const requestedId = searchParams?.get('id') ?? null;
  const missed = searchParams?.get('missed') === '1';
  const stashError = searchParams?.get('error') === 'stash';

  const [bundle, setBundle] = useState<SharedBundle | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Nothing is read for these; the screen says why without waiting on a load.
  const skipsRead = missed || stashError || !isShareInboxSupported();

  useEffect(() => {
    if (skipsRead) return;
    // Still resolving who is reading: stay on the loading state rather than
    // reporting an empty inbox we have not actually looked in.
    if (!viewerUserId) return;
    let cancelled = false;

    const load = async () => {
      // No id means the user reached this page some other way (the launcher,
      // a bookmark). The newest live bundle is the one they would have been
      // sent to, so show that rather than nothing.
      let id = requestedId;
      if (!isShareBundleId(id ?? '')) {
        const bundles = await listSharedBundles(viewerUserId);
        id = bundles[0]?.id ?? null;
      }
      const found = id ? await readSharedBundle(id, viewerUserId) : null;
      if (cancelled) return;
      setBundle(found);
      setLoaded(true);
    };

    void load().catch((error) => {
      logger.error('Failed to read the shared bundle:', error);
      if (!cancelled) {
        setBundle(null);
        setLoaded(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [requestedId, skipsRead, viewerUserId]);

  /** The files that are actually usable, and what they can be used for. */
  const usable = useMemo(() => {
    // The worker classified each file on arrival and recorded it on the entry,
    // so this reads that decision rather than making it a second time: two
    // classifiers on one screen is how the glyph beside a file comes to
    // disagree with the destination offered for it.
    const items = (bundle?.items ?? []).flatMap((item) =>
      item.file && item.entry.kind
        ? [{ file: item.file, kind: item.entry.kind }]
        : [],
    );
    const kinds = new Set(items.map((item) => item.kind));
    return {
      files: items.map((item) => item.file),
      // A share is offered a destination only when every usable file agrees on
      // one. Mixed shares are refused rather than half-imported.
      kind: kinds.size === 1 ? [...kinds][0] : null,
    };
  }, [bundle]);

  const state: ReviewState = !loaded && !skipsRead
    ? 'loading'
    : missed
      ? 'missed'
      : stashError
        ? 'error'
        : !isShareInboxSupported()
          ? 'unsupportedBrowser'
          : !bundle
            ? 'notFound'
            : bundle.expired
              ? 'expired'
              : bundle.index.files.length === 0
                ? 'empty'
                : usable.files.length === 0
                  ? 'none'
                  : usable.kind === null
                    ? 'mixed'
                    : 'ready';

  const discard = useCallback(async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      await discardSharedBundle(bundle.index.id);
      setBundle(null);
      toast.success(t('discarded'));
      router.push('/transactions');
    } finally {
      setBusy(false);
    }
  }, [bundle, router, t]);

  const goToAssistant = useCallback(() => {
    if (!bundle) return;
    // Same hand-off as the wizard's: the chat reads the bundle and discards it
    // once it holds the contents, so those bytes keep one owner. Nothing is
    // asked on arrival -- the files land staged on the composer and the user
    // still presses send.
    router.push(`/ai?share=${encodeURIComponent(bundle.index.id)}`);
  }, [bundle, router]);

  const goToImport = useCallback(() => {
    if (!bundle) return;
    // The wizard reads the bundle itself and discards it once it holds the
    // contents: handing it the id keeps one owner of those bytes.
    router.push(`/import?share=${encodeURIComponent(bundle.index.id)}`);
  }, [bundle, router]);

  const onTransactionCreated = useCallback(async () => {
    setShowForm(false);
    // The form awaits its uploads before reporting success, so the bytes are on
    // the server by the time the stash is dropped. It reports success even when
    // an individual upload failed (it toasts and carries on), and dropping the
    // bundle is still right there: the OS shared these files FROM somewhere, so
    // the stash was never the only copy, and keeping a used share would have
    // the notice go on offering it.
    if (bundle) await discardSharedBundle(bundle.index.id);
    setBundle(null);
    toast.success(t('attached'));
    router.push('/transactions');
  }, [bundle, router, t]);

  return (
    <PageLayout>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {state === 'loading' && (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      )}

      {state === 'ready' && bundle && (
        <div className="space-y-6">
          <Card padding="md">
            <h2 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('filesHeading')}
            </h2>
            <SharedFileList items={bundle.items} />
          </Card>
          <Card padding="md">
            <ShareDestinations
              kind={usable.kind!}
              fileCount={usable.files.length}
              onAttach={() => setShowForm(true)}
              onImport={goToImport}
              onSendToAssistant={
                aiConfigured && assistantAcceptsFiles(usable.files)
                  ? goToAssistant
                  : undefined
              }
              onDiscard={() => setConfirmDiscard(true)}
              busy={busy}
            />
          </Card>
        </div>
      )}

      {(state === 'mixed' || state === 'none') && bundle && (
        <div className="space-y-6">
          <Card padding="md">
            <h2 className="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('filesHeading')}
            </h2>
            <SharedFileList items={bundle.items} />
          </Card>
          <Card padding="md">
            <ExplainedState
              title={t(state === 'mixed' ? 'mixedTitle' : 'noneTitle')}
              message={t(state === 'mixed' ? 'mixedMessage' : 'noneMessage')}
              action={
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDiscard(true)}
                  disabled={busy}
                >
                  {t('discard')}
                </Button>
              }
            />
          </Card>
        </div>
      )}

      {state === 'empty' && (
        <SimpleState title={t('emptyTitle')} message={t('emptyMessage')} />
      )}
      {state === 'notFound' && (
        <SimpleState
          title={t('notFoundTitle')}
          message={t('notFoundMessage')}
          action={
            <Button onClick={() => router.push('/transactions')}>
              {t('goToTransactions')}
            </Button>
          }
        />
      )}
      {state === 'expired' && (
        <SimpleState
          title={t('expiredTitle')}
          message={t('expiredMessage')}
          action={
            <Button onClick={() => router.push('/transactions')}>
              {t('goToTransactions')}
            </Button>
          }
        />
      )}
      {state === 'missed' && (
        <SimpleState
          title={t('missedTitle')}
          message={t('missedMessage')}
          action={
            <Button onClick={() => router.push('/transactions')}>
              {t('goToTransactions')}
            </Button>
          }
        />
      )}
      {state === 'error' && (
        <SimpleState
          title={t('errorTitle')}
          message={t('errorMessage')}
          action={
            <Button onClick={() => router.push('/transactions')}>
              {t('goToTransactions')}
            </Button>
          }
        />
      )}
      {state === 'unsupportedBrowser' && (
        <SimpleState
          title={t('unsupportedBrowserTitle')}
          message={t('unsupportedBrowserMessage')}
          action={
            <Button onClick={() => router.push('/import')}>
              {t('goToImport')}
            </Button>
          }
        />
      )}

      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title={t('newTransactionTitle')}
        {...transactionModalProps}
        pushHistory
      >
        <TransactionForm
          initialStagedFiles={usable.files}
          onSuccess={onTransactionCreated}
          onCancel={() => setShowForm(false)}
        />
      </Modal>

      <ConfirmDialog
        isOpen={confirmDiscard}
        title={t('discardConfirmTitle')}
        message={t('discardConfirmMessage')}
        confirmLabel={t('discard')}
        variant="danger"
        onConfirm={() => {
          setConfirmDiscard(false);
          void discard();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </PageLayout>
  );
}

function SimpleState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <Card padding="md">
      <EmptyState
        icon={<InboxArrowDownIcon />}
        title={title}
        description={message}
        action={action}
      />
    </Card>
  );
}

function ExplainedState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {title}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
      {action}
    </div>
  );
}
