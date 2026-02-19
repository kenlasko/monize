'use client';

import { useRouter } from 'next/navigation';
import type { BudgetAlert, AlertSeverity } from '@/types/budget';

interface BudgetAlertListProps {
  alerts: BudgetAlert[];
  isLoading: boolean;
  onMarkRead: (alertId: string) => void;
  onMarkAllRead: () => void;
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
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMins > 0) return `${diffMins}m ago`;
  return 'just now';
}

export function BudgetAlertList({
  alerts,
  isLoading,
  onMarkRead,
  onMarkAllRead,
  onClose,
}: BudgetAlertListProps) {
  const router = useRouter();

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  const handleAlertClick = (alert: BudgetAlert) => {
    if (!alert.isRead) {
      onMarkRead(alert.id);
    }
    onClose();
    router.push(`/budgets/${alert.budgetId}`);
  };

  return (
    <div
      className="absolute right-0 mt-1 w-80 sm:w-96 bg-white dark:bg-gray-800 rounded-lg shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50 max-h-[28rem] flex flex-col"
      data-testid="alert-list"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Budget Alerts
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
            No budget alerts
          </div>
        ) : (
          <div>
            {alerts.map((alert) => {
              const styles = severityStyles(alert.severity);
              return (
                <button
                  key={alert.id}
                  onClick={() => handleAlertClick(alert)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    !alert.isRead ? 'bg-gray-50/50 dark:bg-gray-700/20' : ''
                  }`}
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
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      {alerts.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => {
              onClose();
              router.push('/budgets');
            }}
            className="w-full text-center text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 py-1"
            data-testid="view-all-link"
          >
            View all budgets
          </button>
        </div>
      )}
    </div>
  );
}
