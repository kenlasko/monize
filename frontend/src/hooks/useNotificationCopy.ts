'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';

/** Shared display copy for bell rows and reminder templates, including legacy fallback. */
type Notification = {
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
};

interface BillDueAlertData {
  payeeName?: string;
  amount?: number | null;
  amountComplete?: boolean;
  dueDate?: string;
  currencyCode?: string;
}

/**
 * The structured payload a system notification carries (`data.system === true`),
 * following the same rule as `BillDueAlertData`: the row stores English
 * fallbacks, the UI composes localized copy from these facts. Fields are
 * per-type; every one is optional so an older or foreign row falls back to
 * its stored text rather than rendering a hole.
 */
interface SystemAlertData {
  system?: boolean;
  affectedUserId?: string;
  affectedUserEmail?: string | null;
  reason?: string;
  missingAttachments?: number;
  inconsistentAttachments?: number;
  expectedAttachments?: number;
  providerLabel?: string;
  since?: string;
  lastError?: string | null;
  scheduledName?: string;
  dueDate?: string;
  error?: string;
}

function systemAlertData(notification: Notification): SystemAlertData | null {
  const data = notification.data as SystemAlertData | undefined;
  if (!data || data.system !== true) return null;
  return data;
}

function billDueData(notification: Notification): BillDueAlertData | null {
  if (notification.type !== 'BILL_DUE') return null;
  const data = notification.data as BillDueAlertData | undefined;
  if (!data || typeof data.dueDate !== 'string') return null;
  return data;
}

/**
 * Whole days from today to `dueDate`, on the reader's own clock.
 *
 * Counted at render time rather than read from the row: an notification lives until it
 * is dismissed, so a stored "in 3 days" goes on saying three days for as long
 * as the notification is on screen.
 */
function daysUntil(dueDate: string): number {
  const due = new Date(`${dueDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

/**
 * The days-left marks a consent reminder is written at. Mirrors the backend's
 * `CONSENT_REMINDER_THRESHOLDS` (`bank-sync-notifications.ts`), held equal by
 * `bank-sync-notifications.contract.test.ts`.
 */
export const BANK_SYNC_REMINDER_MARKS: readonly number[] = [30, 14, 7, 3, 2, 1, 0];

/**
 * The `failures` a bank sync failure row carries, or null when absent, empty or
 * malformed (the row then shows its stored English whole).
 */
function bankSyncFailures(value: unknown): { label: string | null; code: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const failures: { label: string | null; code: string }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { label, code } = item as Record<string, unknown>;
    if (typeof code !== 'string' || code === '') return null;
    if (label !== null && label !== undefined && typeof label !== 'string') return null;
    failures.push({ label: typeof label === 'string' && label !== '' ? label : null, code });
  }
  return failures;
}

/** A list as the reader's language joins it ("A, B and C"); no separator is written here. */
function joinList(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(items);
  }
}

export function useNotificationCopy() {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const { formatCurrency, formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  /**
   * A bill-due notification's headline, in the reader's language. `null` for anything
   * else -- and for an older row whose data predates these fields -- so the
   * caller falls back to the stored English.
   */
  const billDueTitle = (notification: Notification): string | null => {
    const data = billDueData(notification);
    if (!data) return null;
    const payee = data.payeeName ?? '';
    const days = daysUntil(data.dueDate!);
    if (days < 0) return t('billDue.titleOverdue', { payee });
    if (days === 0) return t('billDue.titleToday', { payee });
    if (days === 1) return t('billDue.titleTomorrow', { payee });
    return t('billDue.titleInDays', { payee, days });
  };

  /**
   * What the bill will cost and when, or an explicit statement that the amount
   * cannot be worked out. Never the persisted snapshot, and never a blank where
   * a figure belongs (issue #1247).
   */
  const billDueMessage = (notification: Notification): string | null => {
    const data = billDueData(notification);
    if (!data) return null;
    if (data.amount == null || data.amountComplete === false) {
      return t('billDue.amountUnavailable', { date: formatDate(data.dueDate!) });
    }
    return t('billDue.amountDue', {
      amount: formatCurrency(data.amount, data.currencyCode),
      date: formatDate(data.dueDate!),
    });
  };

  /**
   * A system notification's headline in the reader's language, or null for other
   * types and for rows without the structured payload (stored English wins).
   */
  const systemAlertTitle = (notification: Notification): string | null => {
    const data = systemAlertData(notification);
    if (!data) return null;
    switch (notification.type) {
      case 'BACKUP_FAILED':
        return t('system.backupFailed.title');
      case 'BACKUP_PARTIAL':
        return t('system.backupPartial.title');
      case 'ENCRYPTION_KEY_MISSING':
        return t('system.encryptionKeyMissing.title');
      case 'JWT_SECRET_WEAK':
        return t('system.jwtSecretWeak.title');
      case 'SMTP_FAILURE':
        return t('system.smtpFailure.title');
      case 'PROVIDER_OUTAGE':
        return data.providerLabel
          ? t('system.providerOutage.title', { provider: data.providerLabel })
          : null;
      case 'PROVIDER_RECOVERED':
        return data.providerLabel
          ? t('system.providerRecovered.title', { provider: data.providerLabel })
          : null;
      case 'SCHEDULED_POST_FAILED':
        return data.scheduledName
          ? t('system.scheduledPostFailed.title', { name: data.scheduledName })
          : null;
      default:
        return null;
    }
  };

  /** The system notification's body, same contract as `systemAlertTitle`. */
  const systemAlertMessage = (notification: Notification): string | null => {
    const data = systemAlertData(notification);
    if (!data) return null;
    const user = data.affectedUserEmail ?? data.affectedUserId ?? '';
    switch (notification.type) {
      case 'BACKUP_FAILED':
        return user ? t('system.backupFailed.message', { user, error: data.error ?? '' }) : null;
      case 'BACKUP_PARTIAL': {
        if (!user) return null;
        if (data.reason === 'attachments') {
          // Both counts, because a run can be partial for either reason
          // alone: rendering only `missing` told the reader "0 attachments
          // could not be included" for a run whose attachments were all
          // present and inconsistent with their metadata.
          if (
            data.missingAttachments === undefined ||
            data.inconsistentAttachments === undefined ||
            data.expectedAttachments === undefined
          ) {
            return null;
          }
          return t('system.backupPartial.messageAttachments', {
            user,
            missing: data.missingAttachments,
            inconsistent: data.inconsistentAttachments,
            expected: data.expectedAttachments,
          });
        }
        // The cause is the actionable half of these two (a permission, a full
        // volume), so it travels into the copy rather than being dropped.
        if (data.reason === 'promotion' && data.error !== undefined) {
          return t('system.backupPartial.messagePromotion', {
            user,
            error: data.error,
          });
        }
        if (data.reason === 'retention' && data.error !== undefined) {
          return t('system.backupPartial.messageRetention', {
            user,
            error: data.error,
          });
        }
        return null;
      }
      case 'ENCRYPTION_KEY_MISSING':
        return t('system.encryptionKeyMissing.message');
      case 'JWT_SECRET_WEAK':
        return t('system.jwtSecretWeak.message');
      case 'SMTP_FAILURE':
        return t('system.smtpFailure.message', { error: data.lastError ?? '' });
      case 'PROVIDER_OUTAGE':
        return data.providerLabel
          ? t('system.providerOutage.message', { provider: data.providerLabel })
          : null;
      case 'PROVIDER_RECOVERED':
        return data.providerLabel
          ? t('system.providerRecovered.message', { provider: data.providerLabel })
          : null;
      case 'SCHEDULED_POST_FAILED':
        return data.dueDate
          ? t('system.scheduledPostFailed.message', {
              date: formatDate(data.dueDate),
              error: data.error ?? '',
            })
          : null;
      default:
        return null;
    }
  };

  /**
   * A GEM recommendation-change row, composed in the reader's language from the
   * `data` facts the producer wrote (`docs/specs/gem-signal-change-notifications.md`).
   * Returns null for any other type, falling back to the stored English.
   */
  const gemSignalData = (
    notification: Notification,
  ): {
    kind?: string;
    strategyName?: string;
    fromState?: string;
    toState?: string;
    toSymbol?: string | null;
    toRole?: string | null;
  } | null => {
    if (notification.type !== 'GEM_SIGNAL_CHANGED') return null;
    return (notification.data ?? {}) as {
      kind?: string;
      strategyName?: string;
      fromState?: string;
      toState?: string;
      toSymbol?: string | null;
      toRole?: string | null;
    };
  };

  const stateLabel = (state: string | undefined): string =>
    state === 'RISK_ON' ? t('gemSignal.riskOn') : t('gemSignal.riskOff');

  const gemSignalTitle = (notification: Notification): string | null => {
    const data = gemSignalData(notification);
    if (!data) return null;
    const strategy = data.strategyName ?? '';
    return data.kind === 'risk'
      ? t('gemSignal.riskTitle', { strategy, state: stateLabel(data.toState) })
      : t('gemSignal.allocationTitle', { strategy });
  };

  const gemSignalMessage = (notification: Notification): string | null => {
    const data = gemSignalData(notification);
    if (!data) return null;
    const strategy = data.strategyName ?? '';
    if (data.kind === 'risk') {
      return t('gemSignal.riskMessage', {
        strategy,
        fromState: stateLabel(data.fromState),
        toState: stateLabel(data.toState),
      });
    }
    return t('gemSignal.allocationMessage', {
      strategy,
      target: data.toSymbol ?? data.toRole ?? '',
    });
  };

  /**
   * A daily portfolio-movement row, composed from the producer's `data`
   * (`docs/specs/portfolio-movement-notifications.md`). The percent is already
   * signed by direction; the copy names each direction so it reads naturally in
   * every locale.
   */
  const portfolioMovementData = (
    notification: Notification,
  ): {
    direction?: string;
    changePercent?: number;
    baselineDate?: string;
    valuationDate?: string;
  } | null => {
    if (notification.type !== 'PORTFOLIO_MOVEMENT') return null;
    return (notification.data ?? {}) as {
      direction?: string;
      changePercent?: number;
      baselineDate?: string;
      valuationDate?: string;
    };
  };

  const portfolioMovementTitle = (notification: Notification): string | null => {
    const data = portfolioMovementData(notification);
    if (!data) return null;
    const percent = Math.abs(data.changePercent ?? 0);
    return data.direction === 'down'
      ? t('portfolioMovement.titleDown', { percent })
      : t('portfolioMovement.titleUp', { percent });
  };

  const portfolioMovementMessage = (notification: Notification): string | null => {
    const data = portfolioMovementData(notification);
    if (!data) return null;
    // The period is part of the claim: a Monday run measures from Friday, so the
    // copy names both boundary dates rather than saying "today". A row written
    // before the producer carried them falls back to the server's stored copy.
    if (!data.baselineDate || !data.valuationDate) return null;
    const percent = Math.abs(data.changePercent ?? 0);
    const args = {
      percent,
      from: formatDate(data.baselineDate),
      to: formatDate(data.valuationDate),
    };
    return data.direction === 'down'
      ? t('portfolioMovement.messageDown', args)
      : t('portfolioMovement.messageUp', args);
  };

  /**
   * A balance-threshold crossing row, composed from the producer's `data`
   * (`docs/specs/balance-threshold-notifications.md`). The amount is formatted
   * in the account's own currency (the crossing's currency).
   */
  const balanceThresholdData = (
    notification: Notification,
  ): {
    kind?: string;
    accountName?: string;
    balance?: number;
    threshold?: number;
    currencyCode?: string;
  } | null => {
    if (
      notification.type !== 'BALANCE_BELOW_THRESHOLD' &&
      notification.type !== 'BALANCE_ABOVE_THRESHOLD'
    ) {
      return null;
    }
    return (notification.data ?? {}) as {
      kind?: string;
      accountName?: string;
      balance?: number;
      threshold?: number;
      currencyCode?: string;
    };
  };

  const balanceThresholdTitle = (notification: Notification): string | null => {
    const data = balanceThresholdData(notification);
    if (!data) return null;
    const account = data.accountName ?? '';
    return notification.type === 'BALANCE_ABOVE_THRESHOLD'
      ? t('balanceThreshold.titleHigh', { account })
      : t('balanceThreshold.titleLow', { account });
  };

  const balanceThresholdMessage = (notification: Notification): string | null => {
    const data = balanceThresholdData(notification);
    if (!data) return null;
    const account = data.accountName ?? '';
    const money = (value: number | undefined): string =>
      value == null ? '' : formatCurrency(value, data.currencyCode);
    return notification.type === 'BALANCE_ABOVE_THRESHOLD'
      ? t('balanceThreshold.messageHigh', {
          account,
          balance: money(data.balance),
          threshold: money(data.threshold),
        })
      : t('balanceThreshold.messageLow', {
          account,
          balance: money(data.balance),
          threshold: money(data.threshold),
        });
  };

  /**
   * A bank sync row (consent reminder, expiry notice, failed or successful daily
   * sync), composed from the producer's `data` facts
   * (`docs/specs/bank-sync-notifications.md`). Nothing here counts days from
   * "now": a reminder says what the stored mark and end date say, so the copy is
   * the same on the day it is read as on the day it was written. A row whose
   * facts are missing or malformed returns null and shows its stored English.
   */
  const bankSyncCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    const data = notification.data ?? {};
    const institution = typeof data.institutionName === 'string' ? data.institutionName : '';
    if (institution === '') return null;
    switch (notification.type) {
      case 'BANK_SYNC_CONSENT_EXPIRING': {
        const { threshold, validUntil } = data;
        if (
          typeof threshold !== 'number' ||
          !BANK_SYNC_REMINDER_MARKS.includes(threshold) ||
          typeof validUntil !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)
        ) {
          return null;
        }
        if (part === 'message') {
          return t('bankSync.expiringMessage', { institution, date: formatDate(validUntil) });
        }
        return t(
          threshold === 0
            ? 'bankSync.expiringTitleToday'
            : threshold === 1
              ? 'bankSync.expiringTitleOneDay'
              : 'bankSync.expiringTitleDays',
          { institution, days: formatNumber(threshold, 0) },
        );
      }
      case 'BANK_SYNC_CONSENT_EXPIRED':
        return t(part === 'title' ? 'bankSync.expiredTitle' : 'bankSync.expiredMessage', {
          institution,
        });
      case 'BANK_SYNC_FAILED': {
        const failures = bankSyncFailures(data.failures);
        if (failures === null) return null;
        if (part === 'title') return t('bankSync.failedTitle', { institution });
        // One repair for the reader when every account failed on the credentials.
        if (failures.every((failure) => failure.code === 'credentials')) {
          return t('bankSync.failedCredentialsMessage', { institution });
        }
        return t('bankSync.failedMessage', {
          institution,
          accounts: joinList(
            failures.map((failure) => failure.label ?? t('bankSync.unnamedAccount')),
            locale,
          ),
        });
      }
      case 'BANK_SYNC_IMPORTED': {
        const imported = data.imported;
        if (typeof imported !== 'number' || !Number.isInteger(imported) || imported < 0) {
          return null;
        }
        if (imported === 0) {
          return t(
            part === 'title' ? 'bankSync.importedNoneTitle' : 'bankSync.importedNoneMessage',
            { institution },
          );
        }
        return t(part === 'title' ? 'bankSync.importedTitle' : 'bankSync.importedMessage', {
          institution,
          imported: formatNumber(imported, 0),
        });
      }
      default:
        return null;
    }
  };

  const priceCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    const data = notification.data;
    if (notification.type !== 'SECURITY_PRICE_MOVEMENT' || typeof data?.symbol !== 'string' ||
        typeof data.changePercent !== 'number' || !Number.isFinite(data.changePercent)) return null;
    return t(`priceMovement.${part}`, { symbol: data.symbol, percent: formatNumber(data.changePercent, 2) });
  };

  return (notification: Notification) => ({
    title:
      priceCopy(notification, 'title') ??
      billDueTitle(notification) ??
      systemAlertTitle(notification) ??
      gemSignalTitle(notification) ??
      portfolioMovementTitle(notification) ??
      balanceThresholdTitle(notification) ??
      bankSyncCopy(notification, 'title') ??
      notification.title,
    message:
      priceCopy(notification, 'message') ??
      billDueMessage(notification) ??
      systemAlertMessage(notification) ??
      gemSignalMessage(notification) ??
      portfolioMovementMessage(notification) ??
      balanceThresholdMessage(notification) ??
      bankSyncCopy(notification, 'message') ??
      notification.message,
  });
}
