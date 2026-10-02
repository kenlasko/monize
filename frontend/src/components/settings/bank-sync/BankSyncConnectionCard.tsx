'use client';

import { useId, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useDateFormat } from '@/hooks/useDateFormat';
import { bankSyncApi } from '@/lib/bank-sync';
import { isUnknownSyncOutcome } from '@/lib/bank-sync-outcome';
import { safeAuthorizationUrl } from '@/lib/bank-sync-redirect';
import { getErrorMessage } from '@/lib/errors';
import type { Account } from '@/types/account';
import {
  BANK_SYNC_NOTIFY_SUCCESS_MODES,
  type BankSyncConnection,
  type BankSyncConnectionStatus,
  type BankSyncNotifySuccessMode,
} from '@/types/bank-sync';
import { BankSyncAccountRow } from './BankSyncAccountRow';
import { useBankSyncToast } from './useBankSyncToast';

/** Consent that ends within this many days is flagged as expiring soon. */
const EXPIRES_SOON_DAYS = 7;
const DAY_MS = 86_400_000;

const STATUS_VARIANTS: Record<BankSyncConnectionStatus, BadgeVariant> = {
  pending: 'blue',
  active: 'green',
  expired: 'amber',
  revoked: 'gray',
  failed: 'red',
};

interface BankSyncConnectionCardProps {
  connection: BankSyncConnection;
  accounts: Account[];
  /** Monize accounts linked to a bank account of ANY connection. */
  linkedAccountIds: ReadonlySet<string>;
  disabled?: boolean;
  /** Reload connections and accounts after a write. */
  onChanged: () => Promise<void> | void;
}

/**
 * One bank connection: its consent, its automatic-sync switch and its accounts.
 *
 * The consent is the thing that lapses, so the card says when and offers a
 * renewal before it does. A connection whose `valid_until` has passed is shown
 * as expired even when the server has not yet marked the row -- it marks it on
 * the next sync attempt, and the reader should not have to trigger that to be
 * told.
 */
export function BankSyncConnectionCard({
  connection,
  accounts,
  linkedAccountIds,
  disabled = false,
  onChanged,
}: BankSyncConnectionCardProps) {
  const t = useTranslations('settings.bankSync.connection');
  const tConnect = useTranslations('settings.bankSync.connect');
  const tSync = useTranslations('settings.bankSync.sync');
  const { formatDate } = useDateFormat();
  const notifySync = useBankSyncToast();
  // Captured once: consent is measured in days, so a clock that stands still
  // for the life of the page is exact enough, and render stays pure.
  const [now] = useState(() => Date.now());
  const syncAllHintId = useId();
  const [autoSync, setAutoSync] = useState(connection.autoSync);
  const [savingAutoSync, setSavingAutoSync] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [notifySuccess, setNotifySuccess] = useState(connection.notifySuccess);
  const [savingNotifySuccess, setSavingNotifySuccess] = useState(false);
  const [tagOperationType, setTagOperationType] = useState(connection.tagOperationType);
  const [savingTagOperationType, setSavingTagOperationType] = useState(false);

  // The server's value wins whenever a reload brings a different one.
  const [seenAutoSync, setSeenAutoSync] = useState(connection.autoSync);
  if (seenAutoSync !== connection.autoSync) {
    setSeenAutoSync(connection.autoSync);
    setAutoSync(connection.autoSync);
  }
  const [seenTagOperationType, setSeenTagOperationType] = useState(connection.tagOperationType);
  if (seenTagOperationType !== connection.tagOperationType) {
    setSeenTagOperationType(connection.tagOperationType);
    setTagOperationType(connection.tagOperationType);
  }
  const [seenNotifySuccess, setSeenNotifySuccess] = useState(connection.notifySuccess);
  if (seenNotifySuccess !== connection.notifySuccess) {
    setSeenNotifySuccess(connection.notifySuccess);
    setNotifySuccess(connection.notifySuccess);
  }

  const validUntilMs = connection.validUntil ? Date.parse(connection.validUntil) : NaN;
  const hasExpiry = Number.isFinite(validUntilMs);
  const pastDue = hasExpiry && validUntilMs <= now;
  const expiresSoon =
    connection.status === 'active' &&
    hasExpiry &&
    !pastDue &&
    validUntilMs - now <= EXPIRES_SOON_DAYS * DAY_MS;
  const displayStatus: BankSyncConnectionStatus =
    connection.status === 'active' && pastDue ? 'expired' : connection.status;
  // A renewal keeps the accounts, so it is the way out of every state that is
  // not a working connection: a lapsed consent, an authorization never
  // completed (`pending`) and one that ended in an error (`failed`).
  const canRenew =
    displayStatus === 'expired' ||
    displayStatus === 'pending' ||
    displayStatus === 'failed' ||
    expiresSoon;

  const linkedCount = connection.accounts.filter((account) => account.accountId).length;
  const canSyncAll = displayStatus === 'active' && linkedCount > 0;
  // A link nobody has confirmed yet is imported from its own preview, never as
  // part of "Sync all": that would write a first import nobody has looked at.
  const syncAllWaitsForPreview =
    canSyncAll && connection.accounts.some((account) => account.accountId && account.needsPreview);
  const showAutoSync = displayStatus === 'active' || displayStatus === 'expired';
  const busy = syncing || matching || renewing || disconnecting;
  // Matching has nothing to do once every bank account is linked.
  const canMatch =
    displayStatus === 'active' && connection.accounts.some((account) => account.accountId === null);

  // Accounts linked to a bank account of ANOTHER row stay off this row's
  // picker; its own link stays offered so it renders as selected.
  const linkedElsewhereFor = (ownAccountId: string | null): ReadonlySet<string> => {
    if (!ownAccountId) return linkedAccountIds;
    const others = new Set(linkedAccountIds);
    others.delete(ownAccountId);
    return others;
  };

  const handleAutoSync = async (next: boolean) => {
    if (savingAutoSync) return;
    const previous = autoSync;
    setAutoSync(next);
    setSavingAutoSync(true);
    try {
      await bankSyncApi.updateConnection(connection.id, { autoSync: next });
      toast.success(next ? t('autoSyncOn') : t('autoSyncOff'));
    } catch (error) {
      // Back to the value THIS change replaced.
      setAutoSync(previous);
      toast.error(getErrorMessage(error, t('autoSyncFailed')));
    } finally {
      setSavingAutoSync(false);
    }
  };

  const handleTagOperationType = async (next: boolean) => {
    if (savingTagOperationType) return;
    const previous = tagOperationType;
    setTagOperationType(next);
    setSavingTagOperationType(true);
    try {
      await bankSyncApi.updateConnection(connection.id, { tagOperationType: next });
      toast.success(next ? t('tagOperationTypeOn') : t('tagOperationTypeOff'));
    } catch (error) {
      setTagOperationType(previous);
      toast.error(getErrorMessage(error, t('tagOperationTypeFailed')));
    } finally {
      setSavingTagOperationType(false);
    }
  };

  // Saved as soon as it changes, and put back to the value it replaced when the
  // server refuses, so the control never shows a setting the server does not hold.
  const handleNotifySuccess = async (next: BankSyncNotifySuccessMode) => {
    if (savingNotifySuccess || next === notifySuccess) return;
    const previous = notifySuccess;
    setNotifySuccess(next);
    setSavingNotifySuccess(true);
    try {
      await bankSyncApi.updateConnection(connection.id, { notifySuccess: next });
      toast.success(t('notifySuccessSaved'));
    } catch (error) {
      setNotifySuccess(previous);
      toast.error(getErrorMessage(error, t('notifySuccessFailed')));
    } finally {
      setSavingNotifySuccess(false);
    }
  };

  const handleRenew = async () => {
    setRenewing(true);
    try {
      const { authorizationUrl } = await bankSyncApi.reauthorize(connection.id);
      const safeUrl = safeAuthorizationUrl(authorizationUrl);
      if (!safeUrl) {
        toast.error(tConnect('unsafeUrl'));
        setRenewing(false);
        return;
      }
      // Leaves the app; `renewing` stays set so the button cannot fire twice.
      window.location.assign(safeUrl);
    } catch (error) {
      toast.error(getErrorMessage(error, t('renewFailed')));
      setRenewing(false);
    }
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      notifySync(await bankSyncApi.syncConnection(connection.id), connection.accounts);
    } catch (error) {
      toast.error(
        isUnknownSyncOutcome(error)
          ? tSync('outcomeUnknown')
          : getErrorMessage(error, t('syncAllFailed')),
      );
    } finally {
      setSyncing(false);
      await onChanged();
    }
  };

  // Link each bank account to the Monize account with the same account number.
  // The toast says how many were linked and how many matched more than one
  // account, which the person has to choose between.
  const handleMatch = async () => {
    setMatching(true);
    try {
      const { linked, suggestions } = await bankSyncApi.matchAccounts(connection.id);
      const linkedText = t('matchLinked', { count: linked.length });
      const suggestedText = t('matchSuggested', { count: suggestions.length });
      if (linked.length > 0 && suggestions.length > 0) {
        toast.success(t('matchBoth', { linked: linkedText, suggested: suggestedText }));
      } else if (linked.length > 0) {
        toast.success(linkedText);
      } else if (suggestions.length > 0) {
        toast(suggestedText, { duration: 8000 });
      } else {
        toast(t('matchNone'));
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('matchFailed')));
    } finally {
      setMatching(false);
      await onChanged();
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await bankSyncApi.deleteConnection(connection.id);
      toast.success(t('disconnected'));
      setShowDisconnect(false);
      await onChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t('disconnectFailed')));
      setDisconnecting(false);
      setShowDisconnect(false);
    }
  };

  return (
    <Card padding="md" className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {connection.institutionName}
            </h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {connection.institutionCountry}
            </span>
            <Badge variant={STATUS_VARIANTS[displayStatus]}>
              {t(`status.${displayStatus}`)}
            </Badge>
            {expiresSoon && <Badge variant="amber">{t('expiresSoon')}</Badge>}
          </div>
          {connection.validUntil && hasExpiry && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {t('validUntil', { date: formatDate(connection.validUntil) })}
            </p>
          )}
          {connection.status === 'failed' && connection.lastError && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              {connection.lastError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canRenew && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRenew}
              disabled={disabled || busy}
            >
              {t('renew')}
            </Button>
          )}
          {canMatch && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleMatch}
              disabled={disabled || busy}
            >
              {matching ? t('matching') : t('matchAccounts')}
            </Button>
          )}
          {canSyncAll && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSyncAll}
              disabled={disabled || busy || syncAllWaitsForPreview}
              aria-describedby={syncAllWaitsForPreview ? syncAllHintId : undefined}
            >
              {syncing ? t('syncingAll') : t('syncAll')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowDisconnect(true)}
            disabled={disabled || busy}
          >
            {t('disconnect')}
          </Button>
        </div>
      </div>

      {syncAllWaitsForPreview && (
        <p id={syncAllHintId} className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {t('syncAllNeedsPreview')}
        </p>
      )}

      {showAutoSync && (
        <div className="mt-3 flex items-center gap-3">
          <ToggleSwitch
            checked={autoSync}
            onChange={handleAutoSync}
            disabled={disabled || savingAutoSync}
            label={t('autoSync')}
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {t('autoSync')}
          </span>
        </div>
      )}

      {showAutoSync && (
        <div className="mt-3 flex items-center gap-3">
          <ToggleSwitch
            checked={tagOperationType}
            onChange={handleTagOperationType}
            disabled={disabled || savingTagOperationType}
            label={t('tagOperationType')}
          />
          <span className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300">
            {t('tagOperationType')}
            <InfoTooltip text={t('tagOperationTypeHelp')} usePortal />
          </span>
        </div>
      )}

      {showAutoSync && (
        <div className="mt-3 max-w-md">
          <Select
            id={`notify-success-${connection.id}`}
            label={t('notifySuccess')}
            value={notifySuccess}
            onChange={(event) =>
              void handleNotifySuccess(event.target.value as BankSyncNotifySuccessMode)
            }
            disabled={disabled || savingNotifySuccess}
            options={BANK_SYNC_NOTIFY_SUCCESS_MODES.map((mode) => ({
              value: mode,
              label: t(`notifySuccessOptions.${mode}`),
            }))}
          />
        </div>
      )}

      {connection.status === 'pending' && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          {t('pendingHint')}
        </p>
      )}
      {connection.accounts.length === 0 ? (
        connection.status !== 'pending' && (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
            {t('noAccounts')}
          </p>
        )
      ) : (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('accountsHeading')}
          </h4>
          <ul>
            {connection.accounts.map((bankAccount) => (
              <BankSyncAccountRow
                key={bankAccount.id}
                bankAccount={bankAccount}
                connectionActive={displayStatus === 'active'}
                accounts={accounts}
                linkedElsewhere={linkedElsewhereFor(bankAccount.accountId)}
                disabled={disabled}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        isOpen={showDisconnect}
        title={t('disconnectConfirm.title', { bank: connection.institutionName })}
        message={t('disconnectConfirm.message')}
        confirmLabel={t('disconnectConfirm.confirm')}
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnect(false)}
        pushHistory
      />
    </Card>
  );
}
