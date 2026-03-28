'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { actionHistoryApi, type ActionHistoryItem } from '@/lib/action-history';
import { clearAllCache } from '@/lib/apiCache';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ActionHistoryPanel');

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000,
  );
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const entityLabels: Record<string, string> = {
  transaction: 'Transaction',
  transfer: 'Transfer',
  investment_transaction: 'Investment',
  bulk_transaction: 'Bulk',
  category: 'Category',
  payee: 'Payee',
  tag: 'Tag',
  account: 'Account',
  scheduled_transaction: 'Scheduled',
  security: 'Security',
  budget: 'Budget',
};

export function ActionHistoryPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [history, setHistory] = useState<ActionHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const pendingRef = useRef(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const canUndo = history.some((h) => !h.isUndone);
  const canRedo = history.some((h) => h.isUndone);

  const fetchHistory = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await actionHistoryApi.getHistory(20);
      setHistory(data);
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch history when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchHistory();
    }
  }, [isOpen, fetchHistory]);

  // Refresh history when undo/redo happens via keyboard
  useEffect(() => {
    const handler = () => {
      if (isOpen) fetchHistory();
    };
    window.addEventListener('undoredo', handler);
    return () => window.removeEventListener('undoredo', handler);
  }, [isOpen, fetchHistory]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleUndo = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.undo();
      toast.success(result.description);
      clearAllCache();
      window.dispatchEvent(new CustomEvent('undoredo'));
      await fetchHistory();
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success('Nothing to undo');
      } else if (status === 409) {
        toast.error(message || 'Cannot undo this action');
      } else {
        logger.error('Undo failed', error);
        toast.error('Undo failed');
      }
    } finally {
      pendingRef.current = false;
    }
  };

  const handleRedo = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.redo();
      toast.success(result.description);
      clearAllCache();
      window.dispatchEvent(new CustomEvent('undoredo'));
      await fetchHistory();
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success('Nothing to redo');
      } else if (status === 409) {
        toast.error(message || 'Cannot redo this action');
      } else {
        logger.error('Redo failed', error);
        toast.error('Redo failed');
      }
    } finally {
      pendingRef.current = false;
    }
  };

  const isMac =
    typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const mod = isMac ? 'Cmd' : 'Ctrl';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
        title="Action History"
        aria-label="Action History"
        data-testid="action-history-button"
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
            d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          className="fixed left-3 right-3 top-14 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 flex flex-col max-h-[28rem]"
          data-testid="action-history-panel"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Action History
            </h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 sm:hidden"
              aria-label="Close"
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

          {/* Undo/Redo buttons */}
          <div className="flex gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
            <button
              onClick={handleUndo}
              disabled={!canUndo && history.length > 0}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="undo-button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
                />
              </svg>
              Undo
              <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500 ml-1">
                {mod}+Z
              </span>
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo && history.length > 0}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="redo-button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3"
                />
              </svg>
              Redo
              <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500 ml-1">
                {mod}+Shift+Z
              </span>
            </button>
          </div>

          {/* History list */}
          <div className="overflow-y-auto flex-1">
            {isLoading && history.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
              </div>
            ) : history.length === 0 ? (
              <div className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">
                No recent actions
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className={`px-4 py-2.5 ${
                      item.isUndone
                        ? 'opacity-50'
                        : ''
                    }`}
                    data-testid="history-item"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm text-gray-900 dark:text-gray-100 truncate ${
                            item.isUndone ? 'line-through' : ''
                          }`}
                        >
                          {item.description}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                            {entityLabels[item.entityType] || item.entityType}
                          </span>
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {timeAgo(item.createdAt)}
                          </span>
                        </div>
                      </div>
                      {item.isUndone && (
                        <span className="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap mt-0.5">
                          Undone
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
