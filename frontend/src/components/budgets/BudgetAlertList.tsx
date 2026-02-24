'use client';

import { useRouter } from 'next/navigation';
import type { BudgetAlert, AlertSeverity } from '@/types/budget';

interface BudgetAlertListProps {
  alerts: BudgetAlert[];
  isLoading: boolean;
  onMarkRead: (alertId: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (alertId: string) => void;
  onUndoDismiss: (alertId: string) => void;
  dismissingIds: Set<string>;
  collapsingIds: Set<string>;
  onClose: () => void;
}

function severityStyles(severity: AlertSeverity): {
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

function severityLabel(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical':
      return 'Critical';
    case 'warning':
      return 'Warning';
    case 'success':
      return 'Good News';
    default:
      return 'Info';
  }
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const absDiffMins = Math.floor(absDiffMs / 60000);
  const absDiffHours = Math.floor(absDiffMins / 60);
  const absDiffDays = Math.floor(absDiffHours / 24);

  if (diffMs < 0) {
    // Future date
    if (absDiffDays > 0) return `in ${absDiffDays}d`;
    if (absDiffHours > 0) return `in ${absDiffHours}h`;
    return 'today';
  }

  if (absDiffDays > 0) return `${absDiffDays}d ago`;
  if (absDiffHours > 0) return `${absDiffHours}h ago`;
  if (absDiffMins > 0) return `${absDiffMins}m ago`;
  return 'just now';
}

export function BudgetAlertList({
  alerts,
  isLoading,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onUndoDismiss,
  dismissingIds,
  collapsingIds,
  onClose,
}: BudgetAlertListProps) {
  const router = useRouter();

  const unreadCount = alerts.filter((a) => !a.isRead && !dismissingIds.has(a.id)).length;

  const handleAlertClick = (alert: BudgetAlert) => {
    if (!alert.isRead) {
      onMarkRead(alert.id);
    }
    onClose();
    if (alert.alertType === 'BILL_DUE') {
      router.push('/bills');
    } else {
      router.push(`/budgets/${alert.budgetId}`);
    }
  };

  return (
    <div
      className="fixed left-3 right-3 top-14 sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-1 sm:w-96 bg-white dark:bg-gray-800 rounded-lg shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50 max-h-[28rem] flex flex-col"
      data-testid="alert-list"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Alerts
          {unreadCount > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
              {unreadCount} unread
            </span>
          )}
        </h3>
        {unreadCount > 0 && (
          <button
            onClick={onMarkAllRead}
            className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            data-testid="mark-all-read"
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Alert list */}
      <div className="overflow-y-auto flex-1">
        {isLoading && alerts.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Loading alerts...
          </div>
        ) : alerts.length === 0 ? (
          <div
            className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
            data-testid="no-alerts"
          >
            No alerts
          </div>
        ) : (
          <div>
            {alerts.map((alert) => {
              const styles = severityStyles(alert.severity);
              const isDismissing = dismissingIds.has(alert.id);
              const isCollapsing = collapsingIds.has(alert.id);
              return (
                <div
                  key={alert.id}
                  className={`transition-all duration-300 overflow-hidden ${
                    isCollapsing ? 'max-h-0 opacity-0' : 'max-h-28'
                  }`}
                >
                  {isDismissing ? (
                    <div
                      className="border-b border-gray-100 dark:border-gray-700/50 px-4 py-3 flex items-center justify-center"
                      data-testid={`undo-alert-${alert.id}`}
                    >
                      <button
                        onClick={() => onUndoDismiss(alert.id)}
                        className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                        data-testid={`undo-dismiss-${alert.id}`}
                      >
                        Undo
                      </button>
                    </div>
                  ) : (
                    <div
                      className={`relative group border-b border-gray-100 dark:border-gray-700/50 ${
                        !alert.isRead ? 'bg-gray-50/50 dark:bg-gray-700/20' : ''
                      }`}
                    >
                      <button
                        onClick={() => handleAlertClick(alert)}
                        className="w-full text-left px-4 py-3 pr-9 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                        data-testid={`alert-item-${alert.id}`}
                      >
                        <div className="flex items-start gap-3">
                          {/* Unread dot */}
                          <div className="mt-1.5 flex-shrink-0">
                            {!alert.isRead ? (
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
                                {severityLabel(alert.severity)}
                              </span>
                              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                                {timeAgo(alert.createdAt)}
                              </span>
                            </div>
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {alert.title}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mt-0.5">
                              {alert.message}
                            </p>
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDismiss(alert.id);
                        }}
                        className="absolute top-2 right-2 p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        data-testid={`dismiss-alert-${alert.id}`}
                        aria-label="Dismiss alert"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                        </svg>
                      </button>
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
