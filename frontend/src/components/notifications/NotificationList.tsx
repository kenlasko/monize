'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useNotificationCopy } from '@/hooks/useNotificationCopy';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import Link from 'next/link';
import type { NotificationFilters } from '@/lib/notification-filters';
import { hasActiveNotificationFilters } from '@/lib/notification-filters';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { NotificationFilterCategory, Notification, NotificationSeverity } from '@/types/notification';
import { safeNotificationTarget } from '@/lib/notification-target';
import { RemindMeButton } from './RemindMeButton';

/**
 * Where clicking an notification takes the reader, per type. `null` means the click
 * marks it read and closes the dropdown, nothing more -- there is no page
 * that says more than the notification itself (the provider pair), or no page to
 * point at (a budget notification whose budgetId is null, which used to push the
 * broken route /budgets/null).
 */
function notificationRoute(notification: Notification): string | null {
  // The server's answer wins: the producer knows which budget, bill or security
  // the row is about, and the client only knows its type. Rows written before
  // `target` existed carry none, and during a rolling deploy the list holds both
  // shapes at once -- so the table below is the fallback, not the rule.
  const target = safeNotificationTarget(notification.target);
  if (target) return target;

  switch (notification.type) {
    case "SHARED_EXPENSE_UPDATED":
      return "/shared-expenses";
    case 'BILL_DUE':
    case 'SCHEDULED_POST_FAILED':
      return '/bills';
    case 'BACKUP_FAILED':
    case 'BACKUP_PARTIAL':
    case 'ENCRYPTION_KEY_MISSING':
    case 'SMTP_FAILURE':
      return '/settings';
    case 'AI_REVIEW_PROPOSALS_READY':
    case 'AI_REVIEW_PROPOSALS_EXPIRING':
      return '/ai-reviews';
    case 'WARRANTY_EXPIRING':
    case 'WARRANTY_EXPIRES_TODAY': {
      const warrantyId = notification.data?.warrantyId;
      return typeof warrantyId === 'string' && warrantyId !== '' ? `/warranties/${warrantyId}` : '/warranties';
    }
    case 'EMAIL_RECEIPTS_ATTENTION':
      return '/email-receipts?tab=emails';
    case 'PROVIDER_OUTAGE':
    case 'PROVIDER_RECOVERED':
    // A server setting, fixed in the deployment's configuration: no page here
    // says more than the notification does.
    case 'JWT_SECRET_WEAK':
      return null;
    default:
      return notification.budgetId ? `/budgets/${notification.budgetId}` : null;
  }
}

interface NotificationListProps {
  /** The notifications matching the active filter -- the owner filters, this renders. */
  notifications: Notification[];
  isLoading: boolean;
  onMarkRead: (notificationId: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (notificationId: string) => void;
  onUndoDismiss: (notificationId: string) => void;
  dismissingIds: Set<string>;
  collapsingIds: Set<string>;
  onClose: () => void;
  filters: NotificationFilters;
  onFiltersChange: (filters: NotificationFilters) => void;
  /** Asks the owner to confirm and dismiss everything matching `filters`. */
  onDeleteAll: () => void;
  /** Owner-only mutations, including read state and reminders. */
  canManageNotifications?: boolean;
}

const SEVERITY_FILTER_OPTIONS: readonly NotificationSeverity[] = [
  'critical',
  'warning',
  'info',
  'success',
];

const CATEGORY_FILTER_OPTIONS: readonly NotificationFilterCategory[] = [
  'financial',
  'system',
];

const FILTER_CHIP_CLASS =
  'flex-shrink-0 transition-colors motion-reduce:transition-none';

function severityStyles(severity: NotificationSeverity): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  switch (severity) {
    case 'critical':
      return {
        bg: 'bg-red-50 dark:bg-red-900/20',
        text: 'text-red-700 dark:text-red-300',
        border: 'border-red-200 dark:border-red-800',
        dot: 'bg-red-500',
      };
    case 'warning':
      return {
        bg: 'bg-amber-50 dark:bg-amber-900/20',
        text: 'text-amber-700 dark:text-amber-300',
        border: 'border-amber-200 dark:border-amber-800',
        dot: 'bg-amber-500',
      };
    case 'success':
      return {
        bg: 'bg-green-50 dark:bg-green-900/20',
        text: 'text-green-700 dark:text-green-300',
        border: 'border-green-200 dark:border-green-800',
        dot: 'bg-green-500',
      };
    default:
      return {
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        text: 'text-blue-700 dark:text-blue-300',
        border: 'border-blue-200 dark:border-blue-800',
        dot: 'bg-blue-500',
      };
  }
}

function severityLabel(severity: NotificationSeverity, t: (key: string) => string): string {
  switch (severity) {
    case 'critical':
      return t('severity.critical');
    case 'warning':
      return t('severity.warning');
    case 'success':
      return t('severity.success');
    default:
      return t('severity.info');
  }
}

export function NotificationList({
  notifications,
  isLoading,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onUndoDismiss,
  dismissingIds,
  collapsingIds,
  onClose,
  filters,
  onFiltersChange,
  onDeleteAll,
  canManageNotifications = true,
}: NotificationListProps) {
  const t = useTranslations('notifications');
  /**
   * The row's timestamp, in the reader's language, through the app's one
   * relative-time formatter rather than a hand-written `${n}h ago`. It also
   * gets future dates right in every language ("in 2 days").
   */
  const formatRelativeTime = useRelativeTime();
  const router = useRouter();
  const copy = useNotificationCopy();
  const unreadCount = notifications.filter((a) => !a.isRead && !dismissingIds.has(a.id)).length;
  // Rows whose full message is showing. A notification with no page to open
  // (a server-configuration alert, say) has nowhere else to show text that
  // does not fit the two-line preview, so clicking it expands in place.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const handleAlertClick = (notification: Notification) => {
    if (canManageNotifications && !notification.isRead) {
      onMarkRead(notification.id);
    }
    const route = notificationRoute(notification);
    if (route) {
      onClose();
      router.push(route);
      return;
    }
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(notification.id)) {
        next.delete(notification.id);
      } else {
        next.add(notification.id);
      }
      return next;
    });
  };

  const filtered = hasActiveNotificationFilters(filters);

  const toggleSeverity = (severity: NotificationSeverity) => {
    onFiltersChange({
      ...filters,
      severity: filters.severity === severity ? null : severity,
    });
  };

  const toggleCategory = (category: NotificationFilterCategory) => {
    onFiltersChange({
      ...filters,
      category: filters.category === category ? null : category,
    });
  };

  return (
    // Full-screen below `sm` (the phone treatment); the desktop dropdown keeps
    // its card shape via the sm:-scoped rounding, border and height cap.
    //
    // The height is `h-dvh`, never `bottom-0`/`inset-0`: the sliding AppHeader
    // this mounts inside always carries a `transform`, which makes the header
    // -- not the viewport -- the containing block for `position: fixed`, so a
    // bottom anchor caps the panel at the header's own ~56px box (it only
    // *looked* full when notification rows overflowed it). An explicit viewport
    // height grows past the containing block instead.
    <div
      {...tourAnchor(TOUR_ANCHORS.notificationPanel)}
      className="fixed inset-x-0 top-0 h-dvh sm:absolute sm:inset-auto sm:right-0 sm:mt-1 sm:h-auto sm:w-[30rem] bg-white dark:bg-gray-800 sm:rounded-lg shadow-lg dark:shadow-gray-700/50 sm:border border-gray-200 dark:border-gray-700 z-50 sm:max-h-[28rem] flex flex-col"
      data-testid="notification-list"
    >
      {canManageNotifications && (
        <Link href="/reminders" onClick={onClose}
          className="px-4 py-2 text-sm text-blue-600 dark:text-blue-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          {t('reminder.pageTitle')}
        </Link>
      )}
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
          {unreadCount > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
              {t('unread', { count: unreadCount })}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-3">
          {canManageNotifications && unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              data-testid="mark-all-read"
            >
              {t('markAllRead')}
            </button>
          )}
          {canManageNotifications && notifications.length > 0 && (
            <button
              onClick={onDeleteAll}
              className="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300"
              data-testid="delete-all-notifications"
            >
              {t('deleteAll')}
            </button>
          )}
          {/* On mobile the panel covers the screen, so clicking outside is
              impossible -- this is the only way out (ActionHistoryPanel's
              pattern). */}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 sm:hidden"
            aria-label={t('closeAriaLabel')}
            data-testid="close-notifications"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div
        {...tourAnchor(TOUR_ANCHORS.notificationPanelFilters)}
        className="flex flex-col gap-1.5 px-4 py-2 border-b border-gray-200 dark:border-gray-700"
        data-testid="notification-filters"
      >
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
          {SEVERITY_FILTER_OPTIONS.map((severity) => (
            <Badge
              key={severity}
              as="button"
              variant={filters.severity === severity ? 'blue' : 'gray'}
              onClick={() => toggleSeverity(severity)}
              aria-pressed={filters.severity === severity}
              className={FILTER_CHIP_CLASS}
              data-testid={`notification-filter-severity-${severity}`}
            >
              {severityLabel(severity, t)}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
          {CATEGORY_FILTER_OPTIONS.map((category) => (
            <Badge
              key={category}
              as="button"
              variant={filters.category === category ? 'blue' : 'gray'}
              onClick={() => toggleCategory(category)}
              aria-pressed={filters.category === category}
              className={FILTER_CHIP_CLASS}
              data-testid={`notification-filter-category-${category}`}
            >
              {category === 'financial'
                ? t('filter.financial')
                : t('filter.system')}
            </Badge>
          ))}
        </div>
      </div>

      {/* Alert list. The body is a flex column so the loading and empty
          states can center themselves in the leftover height -- on the
          full-screen mobile panel that is most of the screen, while the
          desktop dropdown is content-sized and unaffected. */}
      <div className="overflow-y-auto overscroll-contain flex-1 flex flex-col">
        {isLoading && notifications.length === 0 ? (
          <div className="flex-1 flex flex-col justify-center px-4">
            <LoadingSpinner text={t('loading')} />
          </div>
        ) : notifications.length === 0 ? (
          <div
            className="flex-1 flex flex-col justify-center px-4"
            data-testid="no-notifications"
          >
            <EmptyState
              icon={
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
                  />
                </svg>
              }
              title={filtered ? t('emptyFiltered') : t('empty')}
            />
          </div>
        ) : (
          <div>
            {notifications.map((notification) => {
              const styles = severityStyles(notification.severity);
              const isDismissing = dismissingIds.has(notification.id);
              const isCollapsing = collapsingIds.has(notification.id);
              const expandable = notificationRoute(notification) === null;
              const isExpanded = expandable && expandedIds.has(notification.id);
              return (
                <div
                  key={notification.id}
                  className={`transition-all duration-300 overflow-hidden ${
                    isCollapsing ? 'max-h-0 opacity-0' : isExpanded ? 'max-h-[40rem]' : 'max-h-28'
                  }`}
                >
                  {isDismissing ? (
                    <div
                      className="border-b border-gray-100 dark:border-gray-700/50 px-4 py-3 flex items-center justify-center"
                      data-testid={`undo-notification-${notification.id}`}
                    >
                      <button
                        onClick={() => onUndoDismiss(notification.id)}
                        className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                        data-testid={`undo-dismiss-${notification.id}`}
                      >
                        {t('undo')}
                      </button>
                    </div>
                  ) : (
                    <div
                      className={`relative group border-b border-gray-100 dark:border-gray-700/50 ${
                        !notification.isRead ? 'bg-gray-50/50 dark:bg-gray-700/20' : ''
                      }`}
                    >
                      <button
                        onClick={() => handleAlertClick(notification)}
                        className="w-full text-left px-4 py-3 pr-16 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                        data-testid={`notification-item-${notification.id}`}
                        aria-expanded={expandable ? isExpanded : undefined}
                      >
                        <div className="flex items-start gap-3">
                          {/* Unread dot */}
                          <div className="mt-1.5 flex-shrink-0">
                            {!notification.isRead ? (
                              <div
                                className={`w-2 h-2 rounded-full ${styles.dot}`}
                                data-testid="unread-dot"
                              />
                            ) : (
                              <div className="w-2 h-2" />
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${styles.bg} ${styles.text}`}
                                data-testid="severity-badge"
                              >
                                {severityLabel(notification.severity, t)}
                              </span>
                              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                                {formatRelativeTime(notification.createdAt)}
                              </span>
                            </div>
                            <p
                              className={`text-sm font-medium text-gray-900 dark:text-gray-100 ${
                                isExpanded ? 'break-words' : 'truncate'
                              }`}
                            >
                              {copy(notification).title}
                            </p>
                            <p
                              className={`text-xs text-gray-500 dark:text-gray-400 mt-0.5 ${
                                isExpanded ? 'whitespace-pre-line break-words' : 'line-clamp-2'
                              }`}
                              data-testid={`notification-message-${notification.id}`}
                            >
                              {copy(notification).message}
                            </p>
                          </div>
                        </div>
                      </button>
                      {/* Action controls, siblings of the click button (never
                          nested inside it): remind/stop, then dismiss. */}
                      {canManageNotifications && (
                        <div className="absolute top-2 right-2 flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
                          <RemindMeButton notification={notification} />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDismiss(notification.id);
                            }}
                            className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                            data-testid={`dismiss-notification-${notification.id}`}
                            aria-label={t('dismissAriaLabel')}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
