'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { BellAlertIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useAuthStore } from '@/store/authStore';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNotificationCopy } from '@/hooks/useNotificationCopy';
import { safeNotificationTarget } from '@/lib/notification-target';
import { notificationRemindersApi, type NotificationReminder } from '@/lib/notification-reminders';
import { docsUrl } from '@/lib/docs-links';

export default function RemindersPage() {
  return (
    <ProtectedRoute>
      <RemindersContent />
    </ProtectedRoute>
  );
}

function RemindersContent() {
  const t = useTranslations('notifications');
  const userId = useAuthStore((s) => s.user?.id);
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const [attempt, setAttempt] = useState(0);
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('reminder.pageTitle')}
          helpUrl={docsUrl('notifications')}
        />
        {actingAsUserId ? (
          <p role="status">{t('reminder.delegateUnavailable')}</p>
        ) : userId ? (
          <ActiveReminders key={`${userId}:${attempt}`} retry={() => setAttempt((n) => n + 1)} />
        ) : null}
      </main>
    </PageLayout>
  );
}

function ActiveReminders({ retry }: { retry: () => void }) {
  const t = useTranslations('notifications');
  const common = useTranslations('common');
  const copy = useNotificationCopy();
  const { formatDateTime } = useDateFormat();
  const [rows, setRows] = useState<NotificationReminder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(true);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    notificationRemindersApi.list().then(
      (result) => {
        if (active) setRows(result);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  const stop = async (id: string) => {
    setBusy((current) => new Set([...current, id]));
    try {
      await notificationRemindersApi.stop(id);
      if (!mounted.current) return;
      // The endpoint also succeeds when another tab has already stopped it.
      setRows((current) => current?.filter((row) => row.id !== id) ?? null);
      toast.success(t('reminder.stopped'));
    } catch {
      if (mounted.current) toast.error(t('reminder.stopFailed'));
    } finally {
      if (mounted.current)
        setBusy((current) => new Set([...current].filter((value) => value !== id)));
    }
  };

  if (failed)
    return (
      <Card padding="md">
        <p role="alert">{t('reminder.loadFailed')}</p>
        <Button onClick={retry} variant="outline">
          {t('reminder.retry')}
        </Button>
      </Card>
    );
  if (rows === null) return <LoadingSpinner text={common('loading')} />;
  if (rows.length === 0) return <EmptyState icon={<BellAlertIcon />} title={t('reminder.empty')} />;

  return (
    <ul className="space-y-3 max-h-[70dvh] overflow-y-auto scrollbar-slim">
      {rows.map((row) => {
        const text = copy(row);
        const target = safeNotificationTarget(row.target);
        const interval =
          row.intervalMinutes % 60 === 0
            ? t('reminder.durationHours', { hours: row.intervalMinutes / 60 })
            : t('reminder.durationMinutes', { minutes: row.intervalMinutes });
        return (
          <li key={row.id}>
            <Card padding="md" className="space-y-3 min-w-0">
              <h2 className="font-semibold break-words">{text.title}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-300 break-words">{text.message}</p>
              <p className="text-sm">
                {t(row.repeatMode === 'once' ? 'reminder.modeOnce' : 'reminder.modeRepeat')} ·{' '}
                {interval}
              </p>
              <p className="text-sm">
                {t('reminder.nextFire', { date: formatDateTime(row.nextFireAt) })}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy.has(row.id)}
                  onClick={() => void stop(row.id)}
                >
                  {t('reminder.stopAriaLabel')}
                </Button>
                {target && (
                  <Link
                    href={target}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    {t('reminder.openTarget')}
                  </Link>
                )}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
