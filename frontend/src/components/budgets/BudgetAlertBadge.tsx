'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { budgetsApi } from '@/lib/budgets';
import type { BudgetAlert } from '@/types/budget';
import { BudgetAlertList } from './BudgetAlertList';

export function BudgetAlertBadge() {
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  const fetchAlerts = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await budgetsApi.getAlerts();
      setAlerts(data);
    } catch {
      // Silently fail on alert fetch
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

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

  const handleMarkRead = async (alertId: string) => {
    try {
      await budgetsApi.markAlertRead(alertId);
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, isRead: true } : a)),
      );
    } catch {
      // Silently fail
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await budgetsApi.markAllAlertsRead();
      setAlerts((prev) => prev.map((a) => ({ ...a, isRead: true })));
    } catch {
      // Silently fail
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
        title="Budget alerts"
        aria-label="Budget alerts"
        data-testid="alert-badge-button"
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
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-red-500 rounded-full"
            data-testid="unread-count"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <BudgetAlertList
          alerts={alerts}
          isLoading={isLoading}
          onMarkRead={handleMarkRead}
          onMarkAllRead={handleMarkAllRead}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}
