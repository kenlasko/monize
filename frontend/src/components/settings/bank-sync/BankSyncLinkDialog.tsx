'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { bankSyncApi } from '@/lib/bank-sync';
import { daysBetweenYmd, mayDuplicate } from '@/lib/bank-sync-link-defaults';
import type { AccountType } from '@/types/account';
import type { BankSyncLinkDefaults } from '@/types/bank-sync';
import { useAccountTypeMismatchMessage } from './useAccountTypeMismatchMessage';

interface BankSyncLinkDialogProps {
  isOpen: boolean;
  /** The bank account being linked; its link defaults are read for `accountId`. */
  bankAccountId: string;
  /** The type the bank reported for it (`CARD`, ...), or null when it stated none. */
  bankType: string | null;
  /** The Monize account being linked. */
  accountId: string;
  accountName: string;
  accountType: AccountType | undefined;
  /** Changing the date of a link that already exists rather than making one. */
  editing: boolean;
  /** The date the link already holds, if any. */
  initialDate: string | null;
  onClose: () => void;
  /**
   * `syncFromDate` is `undefined` when the user left the date empty, so the
   * request leaves it out and the server chooses the default.
   */
  onSave: (syncFromDate: string | undefined) => Promise<void>;
}

/** One read of the link defaults: settled, with its answer or with the fact it failed. */
type Defaults =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; data: BankSyncLinkDefaults };

/**
 * The start date of a link: rows the bank booked before it are never imported.
 *
 * **The default is the server's.** The dialog asks for what linking this bank
 * account to this account would default to (`getLinkDefaults`) and opens the
 * date on it, so the date the reader sees is the date the link gets. The form
 * is drawn only once that answer has arrived (or failed), because the date
 * field starts from its initial value and does not follow one set later.
 *
 * **A failed lookup is not an empty account.** When the newest transaction
 * cannot be read the dialog says so and warns about nothing, instead of drawing
 * "the account is empty" over a lookup that did not answer.
 *
 * **A card in a chequing account needs a tick.** When the bank reports the
 * account as a card and the Monize account is not a credit card (or the other
 * way round), linking waits for an explicit confirmation, because importing a
 * card's rows into the wrong kind of account is the mistake this exists to stop.
 */
export function BankSyncLinkDialog({
  isOpen,
  bankAccountId,
  bankType,
  accountId,
  accountName,
  accountType,
  editing,
  initialDate,
  onClose,
  onSave,
}: BankSyncLinkDialogProps) {
  const t = useTranslations('settings.bankSync.link');
  const [defaults, setDefaults] = useState<Defaults>({ state: 'loading' });

  // The dialog is keyed by the pair it links, so a different pair is a new
  // dialog and starts at `loading`; this only has to ignore an answer that
  // arrives after the dialog is gone.
  useEffect(() => {
    let cancelled = false;
    bankSyncApi
      .getLinkDefaults(bankAccountId, accountId)
      .then((data) => {
        if (!cancelled) setDefaults({ state: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setDefaults({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [bankAccountId, accountId]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? t('editTitle', { account: accountName }) : t('title', { account: accountName })}
      padding="md"
      maxWidth="md"
      pushHistory
    >
      {defaults.state === 'loading' ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-600 dark:text-gray-300">
          <LoadingSpinner />
          <span>{t('loadingDefaults')}</span>
        </div>
      ) : (
        <LinkForm
          defaults={defaults.state === 'ready' ? defaults.data : null}
          bankType={bankType}
          accountName={accountName}
          accountType={accountType}
          editing={editing}
          initialDate={initialDate}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </Modal>
  );
}

interface LinkFormProps {
  /** Null when the lookup failed. */
  defaults: BankSyncLinkDefaults | null;
  bankType: string | null;
  accountName: string;
  accountType: AccountType | undefined;
  editing: boolean;
  initialDate: string | null;
  onClose: () => void;
  onSave: (syncFromDate: string | undefined) => Promise<void>;
}

function LinkForm({
  defaults,
  bankType,
  accountName,
  accountType,
  editing,
  initialDate,
  onClose,
  onSave,
}: LinkFormProps) {
  const t = useTranslations('settings.bankSync.link');
  const tMismatch = useTranslations('settings.bankSync.mismatch');
  const { formatDate } = useDateFormat();
  const today = useFinancialToday();
  const mismatchFor = useAccountTypeMismatchMessage();
  const mismatchMessage = mismatchFor(
    bankType,
    accountType ? { name: accountName, accountType } : undefined,
  );
  // Read once, when the form is first drawn: the defaults have arrived by now.
  const [date, setDate] = useState(initialDate ?? defaults?.defaultSyncFromDate ?? '');
  const [confirmedMismatch, setConfirmedMismatch] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(date === '' ? undefined : date);
    } finally {
      setSaving(false);
    }
  };

  const emptyDays =
    defaults && defaults.newestTransactionDate === null
      ? daysBetweenYmd(defaults.defaultSyncFromDate, today)
      : null;
  const needsConfirmation = !editing && mismatchMessage !== null && !confirmedMismatch;

  return (
    <div className="space-y-4">
      <div>
        <DateInput
          label={t('syncFromLabel')}
          id="bank-sync-sync-from"
          value={date}
          onDateChange={setDate}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('syncFromHelp')}</p>
        {defaults === null ? (
          <p role="status" className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            {t('defaultsFailed')}
          </p>
        ) : defaults.newestTransactionDate !== null ? (
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
            {t('newestTransaction', { date: formatDate(defaults.newestTransactionDate) })}
          </p>
        ) : emptyDays !== null ? (
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
            {t('emptyAccount', { days: emptyDays })}
          </p>
        ) : null}
      </div>

      <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
        <li>{t('beforeCutoff')}</li>
        {mayDuplicate(date, defaults?.newestTransactionDate) && (
          <li className="text-amber-700 dark:text-amber-300">{t('duplicateWarning')}</li>
        )}
      </ul>

      {mismatchMessage !== null && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
        >
          <p>{mismatchMessage}</p>
          {!editing && (
            <label className="mt-2 flex cursor-pointer select-none items-start gap-2">
              <input
                type="checkbox"
                checked={confirmedMismatch}
                onChange={(event) => setConfirmedMismatch(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-600"
              />
              <span>{tMismatch('confirm')}</span>
            </label>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          // An existing link's date can only be replaced by a date: an empty
          // field has nothing to send.
          disabled={saving || (editing && date === '') || needsConfirmation}
        >
          {saving ? t('saving') : editing ? t('saveEdit') : t('save')}
        </Button>
      </div>
    </div>
  );
}
