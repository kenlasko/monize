'use client';

import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { useLocale, useTranslations } from 'next-intl';
import {
  groupRefusalReasons,
  isBankSyncFailure,
  isNeedsPreviewFailure,
  syncedResults,
  totalRefused,
  totalSyncResults,
} from '@/lib/bank-sync-summary';
import type { BankSyncAccount, BankSyncConnectionEntry } from '@/types/bank-sync';

/** The fields of a bank account the toast needs to name it. */
type NamedBankAccount = Pick<BankSyncAccount, 'id' | 'displayName' | 'identifierMasked'>;

/**
 * The toast a finished sync earns: how many rows were imported, skipped as
 * already imported, and refused, with each refusal reason named, and which
 * accounts could not be synced at all.
 *
 * A refusal is a bank row that is NOT in the ledger, and a failed account is a
 * whole account that was not read, so a sync that had either is reported as an
 * error toast rather than a success -- the reader has to know something is
 * missing and where. A partial failure still summarises what the other accounts
 * did, because their rows are already imported. A failed account is named by its
 * display name, else its masked number, else a generic label, and carries the
 * server's own sentence about why. Counts are ICU plurals in the catalog, and
 * lists are joined by `Intl.ListFormat` in the reader's locale, so no separator
 * or conjunction is written here.
 */
export function useBankSyncToast() {
  const t = useTranslations('settings.bankSync.sync');
  const tAccount = useTranslations('settings.bankSync.account');
  const locale = useLocale();

  return useCallback(
    (entries: readonly BankSyncConnectionEntry[], accounts: readonly NamedBankAccount[] = []) => {
      let listFormat: Intl.ListFormat;
      try {
        listFormat = new Intl.ListFormat(locale, {
          style: 'long',
          type: 'conjunction',
        });
      } catch {
        listFormat = new Intl.ListFormat(undefined, {
          style: 'long',
          type: 'conjunction',
        });
      }

      const results = syncedResults(entries);
      // An account waiting for its preview was not synced and did not fail: it
      // gets its own sentence naming what to do, not the "could not sync" list.
      const allFailures = entries.filter(isBankSyncFailure);
      const awaitingPreview = allFailures.filter(isNeedsPreviewFailure);
      const failures = allFailures.filter((failure) => !isNeedsPreviewFailure(failure));
      const nameOf = (bankAccountId: string): string => {
        const bankAccount = accounts.find((candidate) => candidate.id === bankAccountId);
        return (
          bankAccount?.displayName || bankAccount?.identifierMasked || tAccount('unnamed')
        );
      };
      const needsPreview =
        awaitingPreview.length === 0
          ? null
          : t('needsPreview', {
              accounts: listFormat.format(
                awaitingPreview.map((entry) => nameOf(entry.bankAccountId)),
              ),
            });
      // Appended to whatever the sync of the other accounts reported.
      const withPreview = (message: string): string =>
        needsPreview === null ? message : t('withNeedsPreview', { message, needsPreview });
      const totals = totalSyncResults(results);
      const refusedCount = totalRefused(totals.refused);
      const summary = t('summary', {
        imported: totals.imported,
        skipped: totals.skipped,
        refused: refusedCount,
      });
      const summaryText =
        refusedCount === 0
          ? summary
          : t('summaryWithReasons', {
              summary,
              reasons: listFormat.format(
                groupRefusalReasons(totals.refused).map(({ reason, count }) =>
                  t(`reason.${reason}`, { count }),
                ),
              ),
            });

      if (failures.length === 0) {
        // Nothing synced and nothing failed: only accounts waiting for their
        // preview. That is a prompt, not a result with counts.
        if (results.length === 0 && needsPreview !== null) {
          toast(needsPreview, { duration: 8000 });
        } else if (refusedCount === 0) {
          // A prompt to act appended to a success stays up long enough to read.
          if (needsPreview === null) toast.success(summary);
          else toast.success(withPreview(summary), { duration: 8000 });
        } else {
          toast.error(withPreview(summaryText), { duration: 8000 });
        }
        return;
      }

      const failedList = listFormat.format(
        failures.map((failure) =>
          t('failedAccountItem', {
            account: nameOf(failure.bankAccountId),
            message: failure.error.message,
          }),
        ),
      );
      toast.error(
        withPreview(
          results.length === 0
            ? t('allFailed', { accounts: failedList })
            : t('partialFailure', { summary: summaryText, accounts: failedList }),
        ),
        { duration: 10000 },
      );
    },
    [t, tAccount, locale],
  );
}
