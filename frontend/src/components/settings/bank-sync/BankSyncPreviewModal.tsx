'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { isAxiosError } from 'axios';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useImportPreviewSelection } from '@/hooks/useImportPreviewSelection';
import { bankSyncApi } from '@/lib/bank-sync';
import { isUnknownSyncOutcome } from '@/lib/bank-sync-outcome';
import { initialPreviewFilter, selectableKeys, type PreviewFilter } from '@/lib/bank-sync-preview';
import { getErrorMessage } from '@/lib/errors';
import type { BankSyncPreview, BankSyncResult } from '@/types/bank-sync';
import { BankSyncPreviewList } from './BankSyncPreviewList';

interface BankSyncPreviewModalProps {
  isOpen: boolean;
  bankAccountId: string;
  /** The Monize account the rows would go into, by name. */
  accountName: string;
  onClose: () => void;
  /** The sync that confirmed the preview finished; the modal has closed its own business. */
  onImported: (result: BankSyncResult) => void;
  /** The confirmation's result could not be learned (a timeout, a 5xx); the server may have written. */
  onOutcomeUnknown: () => void;
}

/** One read of the preview: settled, with its answer or with the error that stopped it. */
type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; error: unknown }
  | { state: 'ready'; preview: BankSyncPreview };

/**
 * What a sync of one bank account would do, row by row, before it does it
 * (docs/specs/bank-sync.md sections 7a and 7b).
 *
 * **Nothing is written to open it**, and what the button writes is exactly
 * what the list shows: the import carries the preview's `planFingerprint`, and
 * the server refuses it (409) when the bank's answer changed in between. The
 * modal then says so and reads the preview again, so the person confirms what
 * the bank says now, not what it said a minute ago.
 *
 * **The person chooses the rows.** Every new row starts checked. An unchecked
 * row is skipped for now (written nowhere, shown again next time) or added to
 * the exceptions (never imported until taken back out). The import sends the
 * fingerprint of the whole plan together with both lists of keys, and the
 * server refuses a key that is not a new row of that plan.
 *
 * **A figure the bank did not give is unknown, not zero**: a missing bank
 * balance says so, and the difference is shown only when both balances are
 * known in one currency. An amount the bank sent unreadable reads "Unknown".
 */
export function BankSyncPreviewModal({
  isOpen,
  bankAccountId,
  accountName,
  onClose,
  onImported,
  onOutcomeUnknown,
}: BankSyncPreviewModalProps) {
  const t = useTranslations('settings.bankSync.preview');
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [filter, setFilter] = useState<PreviewFilter>('all');
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The person's choices about the new rows, and the exceptions picked for removal.
  const selection = useImportPreviewSelection();
  const { prune } = selection;
  const [removeKeys, setRemoveKeys] = useState<ReadonlySet<string>>(new Set());
  // The read the modal is waiting for; an answer to an older one is dropped.
  const latestRequest = useRef(0);
  // The account the first read was started for. A read costs the bank a request
  // and takes the account's lease, so the effect below must not start a second
  // one when React runs it twice in development.
  const startedFor = useRef<string | null>(null);

  const fetchPreview = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const preview = await bankSyncApi.previewAccount(bankAccountId);
      if (request !== latestRequest.current) return;
      setFilter(initialPreviewFilter(preview));
      // A choice about a row the bank still lists as new stands; one about a row
      // that is gone (or already imported) has nothing to apply to.
      prune(selectableKeys(preview.rows));
      setRemoveKeys(new Set());
      setLoaded({ state: 'ready', preview });
    } catch (error) {
      if (request !== latestRequest.current) return;
      setLoaded({ state: 'failed', error });
    }
  }, [bankAccountId, prune]);

  const reload = useCallback(() => {
    setLoaded({ state: 'loading' });
    return fetchPreview();
  }, [fetchPreview]);

  // The modal is mounted when it is opened, and this is the one read it starts.
  useEffect(() => {
    if (startedFor.current === bankAccountId) return;
    startedFor.current = bankAccountId;
    void fetchPreview();
  }, [bankAccountId, fetchPreview]);

  const ready = loaded.state === 'ready' ? loaded.preview : null;
  const chosen = ready ? selection.selectionFor(selectableKeys(ready.rows)) : null;
  const newCount = ready?.summary.new ?? 0;
  const importCount = chosen?.importKeys.length ?? 0;

  const handleImport = async () => {
    if (!ready || !chosen) return;
    setImporting(true);
    try {
      const result = await bankSyncApi.syncAccount(bankAccountId, ready.planFingerprint, {
        importKeys: chosen.importKeys,
        excludeKeys: chosen.excludeKeys,
      });
      onImported(result);
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 409) {
        // Nothing was written. Read the bank again and show what it says now.
        toast.error(t('planChanged'));
        await reload();
      } else if (isUnknownSyncOutcome(error)) {
        onOutcomeUnknown();
      } else {
        toast.error(getErrorMessage(error, t('importFailed')));
      }
    } finally {
      setImporting(false);
    }
  };

  const handleRemove = async () => {
    if (removeKeys.size === 0) return;
    setRemoving(true);
    try {
      const { removed } = await bankSyncApi.removeExceptions(bankAccountId, [...removeKeys]);
      toast.success(removed > 0 ? t('exceptions.removed', { count: removed }) : t('exceptions.removedNone'));
      // The rows are new again only once the bank has been read again.
      await reload();
    } catch (error) {
      toast.error(getErrorMessage(error, t('exceptions.removeFailed')));
    } finally {
      setRemoving(false);
    }
  };

  const busy = importing || removing;
  const importLabel = importing
    ? t('importing')
    : newCount > 0 && importCount === 0
      ? t('importNothing')
      : t('import', { count: importCount });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title', { account: accountName })}
      description={t('description')}
      padding="md"
      maxWidth="6xl"
      fullScreenOnPhone
      fixedHeight
      pushHistory
      footer={
        <>
          {chosen && newCount > 0 && (
            <p
              className="w-full text-sm text-gray-600 sm:mr-auto sm:w-auto dark:text-gray-300"
              aria-live="polite"
            >
              {t('summary', {
                import: chosen.importKeys.length,
                skip: chosen.skipCount,
                except: chosen.excludeKeys.length,
              })}
            </p>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('close')}
          </Button>
          <Button type="button" onClick={handleImport} disabled={ready === null || busy}>
            {importLabel}
          </Button>
        </>
      }
    >
      {loaded.state === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-600 dark:text-gray-300">
          <LoadingSpinner />
          <span>{t('loading')}</span>
        </div>
      )}
      {loaded.state === 'failed' && (
        <div className="space-y-3 py-4">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(loaded.error, t('loadFailed'))}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {ready && (
        <BankSyncPreviewList
          preview={ready}
          filter={filter}
          onFilterChange={setFilter}
          selection={selection}
          removeKeys={removeKeys}
          onRemoveKeysChange={setRemoveKeys}
          onRemove={() => void handleRemove()}
          busy={busy}
          removing={removing}
        />
      )}
    </Modal>
  );
}
