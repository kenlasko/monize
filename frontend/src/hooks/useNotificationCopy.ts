'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { isoToDatetimeLocal, resolveTimezone } from '@/lib/utils';
import { benchmarkLabel } from '@/components/securities/detail/bond-labels';

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
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const { formatDate, timezone } = useDateFormat();
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

  /**
   * The receipts-inbox attention row, composed from the producer's counts. A row
   * without both counts falls back to the stored English.
   */
  const emailReceiptsAttentionData = (
    notification: Notification,
  ): { noParser: number; parseFailed: number } | null => {
    if (notification.type !== 'EMAIL_RECEIPTS_ATTENTION') return null;
    const data = notification.data;
    if (typeof data?.noParser !== 'number' || typeof data.parseFailed !== 'number') return null;
    return { noParser: data.noParser, parseFailed: data.parseFailed };
  };

  const emailReceiptsAttentionTitle = (notification: Notification): string | null =>
    emailReceiptsAttentionData(notification) ? t('emailReceiptsAttention.title') : null;

  const emailReceiptsAttentionMessage = (notification: Notification): string | null => {
    const data = emailReceiptsAttentionData(notification);
    return data
      ? t('emailReceiptsAttention.message', {
          noParser: formatNumber(data.noParser, 0),
          parseFailed: formatNumber(data.parseFailed, 0),
        })
      : null;
  };

  /**
   * The six bond rows (`docs/specs/bond-notifications.md`), composed from `data`
   * alone. Amounts arrive as decimal strings and rates as fractions; a null
   * amount says it is not known yet and why, never a zero. A row missing the
   * facts its copy needs returns null and shows its stored English.
   */
  const bondCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    if (!notification.type.startsWith('BOND_')) return null;
    const data = notification.data ?? {};
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value !== '' ? value : null;
    const decimal = (value: unknown): number | null => {
      const raw = text(value);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const whole = (value: unknown): number | null =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
    const day = (value: unknown): string | null => {
      const raw = text(value);
      return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? formatDate(raw) : null;
    };
    const observation = (value: string): string => {
      const match = /^(\d{4})-(\d{2})$/.exec(value);
      if (!match) return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value;
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
    };
    const rate = (fraction: unknown): string | null => {
      const value = decimal(fraction);
      return value === null ? null : formatPercent(value * 100, 2);
    };
    const series = text(data.seriesCode);
    const currency = text(data.currency);
    const quantity = whole(data.quantity);

    const payoutSentence = (): string | null => {
      if (!currency) return null;
      const payout = decimal(data.payout);
      if (data.payout !== null && payout === null) return null;
      if (payout !== null) {
        return t('bond.payoutKnown', { payout: formatCurrency(payout, currency) });
      }
      const code = typeof data.missing === 'string' ? data.missing : '';
      const known = ['RATE_UNKNOWN', 'TERMS_INCOMPLETE', 'PURCHASE_OUTSIDE_SALE_WINDOW'];
      return t('bond.payoutUnknown', {
        reason: t(known.includes(code) ? `bond.reason.${code}` : 'bond.reason.other'),
      });
    };

    const causeLine = (cause: unknown): string | null => {
      if (typeof cause !== 'object' || cause === null) return null;
      const c = cause as Record<string, unknown>;
      switch (c.code) {
        case 'OBSERVATION_MISSING': {
          const benchmark = text(c.benchmarkId);
          const label = text(c.observation);
          if (!benchmark || !label) return null;
          const publisher = text(c.publisher);
          return publisher
            ? t('bond.cause.observation', {
                observation: observation(label),
                benchmark: benchmarkLabel(t, benchmark),
                publisher,
              })
            : t('bond.cause.observationNoPublisher', {
                observation: observation(label),
                benchmark: benchmarkLabel(t, benchmark),
              });
        }
        case 'TERMS_INCOMPLETE': {
          const code = text(c.seriesCode);
          return code ? t('bond.cause.terms', { series: code }) : null;
        }
        case 'PURCHASE_OUTSIDE_SALE_WINDOW': {
          const code = text(c.seriesCode);
          const date = day(c.purchaseDate);
          const from = day(c.from);
          const to = day(c.to);
          return code && date && from && to
            ? t('bond.cause.purchase', { series: code, date, from, to })
            : null;
        }
        case 'LOTS_UNDERIVABLE': {
          const code = text(c.refusalCode);
          if (!code) return null;
          const rowAction = text(c.action);
          const rowDate = day(c.date);
          // A row raised before the cause named its transaction keeps the older line.
          if (!rowAction || !rowDate) return t('bond.cause.lots', { code });
          // The bell's own labels (`bond.action.*`): the `investments` namespace
          // is not in the public client catalog the bell loads.
          const args = {
            action: t(t.has(`bond.action.${rowAction}`) ? `bond.action.${rowAction}` : 'bond.action.other'),
            date: rowDate,
            code,
          };
          if (code === 'SERIES_NOT_DETERMINED' || code === 'SERIES_REQUIRED') {
            return t('bond.cause.lotsRowSeries', args);
          }
          return t(
            code === 'REMOVAL_EXCEEDS_SERIES' ? 'bond.cause.lotsRowRemoval' : 'bond.cause.lotsRow',
            args,
          );
        }
        default:
          return null;
      }
    };

    switch (notification.type) {
      case 'BOND_MATURITY_SOON':
      case 'BOND_REDEMPTION_UNBOOKED': {
        const date = day(data.maturityDate);
        const payout = payoutSentence();
        if (!series || quantity === null || !date || payout === null) return null;
        const args = { series, date, quantity: formatNumber(quantity, 0), payout };
        const key =
          notification.type === 'BOND_MATURITY_SOON' ? 'bond.maturitySoon' : 'bond.unbooked';
        return t(`${key}${part === 'title' ? 'Title' : 'Message'}`, args);
      }
      case 'BOND_INTEREST_PAYMENT': {
        const date = day(data.paymentDate);
        if (!series || !currency || quantity === null || !date) return null;
        // A null amount is a valid producer state (a rate not published yet); a
        // missing key is an older row and proves nothing.
        if (!('amount' in data)) return null;
        const amount = decimal(data.amount);
        if (data.amount !== null && amount === null) return null;
        const args = { series, date, quantity: formatNumber(quantity, 0) };
        if (part === 'title') return t('bond.interestTitle', args);
        return amount === null
          ? t('bond.interestMessageUnknown', args)
          : t('bond.interestMessage', { ...args, amount: formatCurrency(amount, currency) });
      }
      case 'BOND_RATE_RESET': {
        const date = day(data.periodStart);
        const annual = rate(data.annualRate);
        const period = whole(data.periodIndex);
        if (!series || !date || annual === null || period === null) return null;
        if (part === 'title') return t('bond.rateResetTitle', { series });
        return t('bond.rateResetMessage', {
          series,
          date,
          period: formatNumber(period, 0),
          rate: annual,
        });
      }
      case 'BOND_BENCHMARK_PUBLISHED': {
        const benchmark = text(data.benchmarkId);
        const publisher = text(data.publisher);
        const label = text(data.observation);
        const value = text(data.value);
        const more = whole(data.affectedMore);
        if (!benchmark || !publisher || !label || !value || more === null) return null;
        if (!Array.isArray(data.affected)) return null;
        const lines: string[] = [];
        for (const entry of data.affected as unknown[]) {
          if (typeof entry !== 'object' || entry === null) return null;
          const e = entry as Record<string, unknown>;
          const code = text(e.seriesCode);
          const date = day(e.periodStart);
          if (!code || !date) return null;
          const annual = e.annualRate === null ? null : rate(e.annualRate);
          if (e.annualRate !== null && annual === null) return null;
          // A projected rate is an assumption, never shown as a known one.
          const line =
            annual === null
              ? 'bond.benchmarkSeriesUnknown'
              : e.rateSource === 'PROJECTED'
                ? 'bond.benchmarkSeriesProjected'
                : 'bond.benchmarkSeries';
          lines.push(t(line, { series: code, date, rate: annual ?? '' }));
        }
        if (lines.length === 0) return null;
        const figure = decimal(value);
        if (figure === null) return null;
        const args = {
          benchmark: benchmarkLabel(t, benchmark),
          publisher,
          observation: observation(label),
          // A rate series stores a fraction; any other unit is shown as a plain number.
          value: data.unit === 'RATE_FRACTION' ? formatPercent(figure * 100, 2) : formatNumber(figure, 4),
        };
        if (part === 'title') return t('bond.benchmarkTitle', args);
        const tail = more > 0 ? [t('bond.benchmarkMore', { more: formatNumber(more, 0) })] : [];
        return [t('bond.benchmarkIntro', args), ...lines, ...tail].join(' ');
      }
      case 'BOND_DATA_MISSING': {
        if (!Array.isArray(data.causes) || data.causes.length === 0) return null;
        if (part === 'title') return t('bond.missingTitle');
        const lines = (data.causes as unknown[]).map(causeLine);
        if (lines.some((line) => line === null)) return null;
        return t('bond.missingMessage', { causes: lines.join(' ') });
      }
      default:
        return null;
    }
  };

  /**
   * The AI review rows, composed from the producer's counts. The expiry date is an
   * instant: it is shown as a calendar date in the reader's own timezone. A row
   * without valid facts falls back to the stored English.
   */
  const aiReviewCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    const data = notification.data ?? {};
    const count = data.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
    if (notification.type === 'AI_REVIEW_PROPOSALS_READY') {
      const added = data.added;
      if (typeof added !== 'number' || !Number.isInteger(added) || added < 1) return null;
      return part === 'title' ? t('aiReview.readyTitle') : t('aiReview.readyMessage', { count, added });
    }
    if (notification.type === 'AI_REVIEW_PROPOSALS_EXPIRING') {
      const expiresAt = data.earliestExpiresAt;
      if (typeof expiresAt !== 'string') return null;
      let day: string;
      try {
        day = isoToDatetimeLocal(expiresAt, resolveTimezone(timezone)).slice(0, 10);
      } catch {
        return null;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      return part === 'title'
        ? t('aiReview.expiringTitle')
        : t('aiReview.expiringMessage', { count, date: formatDate(day) });
    }
    return null;
  };

  /**
   * The warranty reminder rows, composed from the producer's facts (name, expiry
   * date, threshold). The title names the mark the reminder fired at, not a count
   * from "now", so it reads the same on the day it is opened as on the day it was
   * written. A row without valid facts falls back to the stored English.
   */
  const warrantyCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    if (notification.type !== 'WARRANTY_EXPIRING' && notification.type !== 'WARRANTY_EXPIRES_TODAY') {
      return null;
    }
    const data = notification.data ?? {};
    const { name, expiresOn, threshold } = data;
    if (typeof name !== 'string' || name === '') return null;
    if (typeof expiresOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return null;
    const date = formatDate(expiresOn);
    if (notification.type === 'WARRANTY_EXPIRES_TODAY') {
      return t(part === 'title' ? 'warranty.todayTitle' : 'warranty.todayMessage', { name, date });
    }
    if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) return null;
    return part === 'title'
      ? t('warranty.expiringTitle', { name, days: threshold })
      : t('warranty.expiringMessage', { name, date });
  };

  /**
   * The payroll deduction reset reminder, from the producer's facts: the
   * category, the bill, the reset date and the maximum that applies again.
   */
  const payrollDeductionCopy = (notification: Notification, part: 'title' | 'message'): string | null => {
    if (notification.type !== 'PAYROLL_DEDUCTION_RESET_DUE') return null;
    const data = notification.data ?? {};
    const { categoryName, scheduledTransactionName, resetOn, yearlyMaximum, currencyCode } = data;
    if (typeof categoryName !== 'string' || categoryName === '') return null;
    if (typeof scheduledTransactionName !== 'string' || scheduledTransactionName === '') return null;
    if (typeof resetOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(resetOn)) return null;
    if (typeof yearlyMaximum !== 'number' || !Number.isFinite(yearlyMaximum)) return null;
    if (typeof currencyCode !== 'string' || currencyCode === '') return null;
    return part === 'title'
      ? t('payrollDeduction.resetTitle', { category: categoryName })
      : t('payrollDeduction.resetMessage', {
          category: categoryName,
          bill: scheduledTransactionName,
          date: formatDate(resetOn),
          amount: formatCurrency(yearlyMaximum, currencyCode),
        });
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
      emailReceiptsAttentionTitle(notification) ??
      aiReviewCopy(notification, 'title') ??
      (notification.type === "SHARED_EXPENSE_UPDATED"
        ? t("shared.title")
        : null) ??
      warrantyCopy(notification, 'title') ??
      payrollDeductionCopy(notification, 'title') ??
      bondCopy(notification, 'title') ??
      notification.title,
    message:
      priceCopy(notification, 'message') ??
      billDueMessage(notification) ??
      systemAlertMessage(notification) ??
      gemSignalMessage(notification) ??
      portfolioMovementMessage(notification) ??
      balanceThresholdMessage(notification) ??
      bankSyncCopy(notification, 'message') ??
      emailReceiptsAttentionMessage(notification) ??
      aiReviewCopy(notification, 'message') ??
      (notification.type === "SHARED_EXPENSE_UPDATED"
        ? t("shared.message")
        : null) ??
      warrantyCopy(notification, 'message') ??
      payrollDeductionCopy(notification, 'message') ??
      bondCopy(notification, 'message') ??
      notification.message,
  });
}
