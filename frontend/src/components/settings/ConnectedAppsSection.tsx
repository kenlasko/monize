'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { oauthConnectionsApi, type ConnectedApp } from '@/lib/oauth-connections';
import { getErrorMessage } from '@/lib/errors';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useRelativeTime } from '@/hooks/useRelativeTime';

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; apps: ConnectedApp[] };

/**
 * The OAuth grants this account has given, each revocable on its own
 * (GHSA-vmgq-326p-fprx). An app's name is whatever it registered itself as, so
 * a row leads with where its authorizations go and shows the name as what the
 * app calls itself, as the consent screen does.
 */
export function ConnectedAppsSection() {
  const t = useTranslations('settings.connectedApps');
  const { formatDate } = useDateFormat();
  const relativeTime = useRelativeTime();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [revoking, setRevoking] = useState<ConnectedApp | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const load = useCallback(() => {
    const run = async () => {
      try {
        const apps = await oauthConnectionsApi.list();
        setState({ status: 'ready', apps });
      } catch (error) {
        // A failed read is not an empty list: say so, and offer a retry.
        setState({ status: 'error' });
        toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      }
    };
    return run();
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRevoke = async () => {
    const app = revoking;
    if (!app) return;
    setIsRevoking(true);
    try {
      await oauthConnectionsApi.revoke(app.id);
      toast.success(t('toasts.revoked'));
      setState((prev) =>
        prev.status === 'ready'
          ? { status: 'ready', apps: prev.apps.filter((a) => a.id !== app.id) }
          : prev,
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.revokeFailed')));
      // The server may have revoked it already (a second tab): read the truth.
      await load();
    } finally {
      setIsRevoking(false);
      setRevoking(null);
    }
  };

  const destinationLine = (app: ConnectedApp): string =>
    app.destinations.length > 0
      ? app.destinations.join(', ')
      : app.clientKnown
        ? t('destinationUnknown')
        : t('registrationExpired');

  return (
    <Card padding="md" className="mb-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('heading')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('description')}
        </p>
      </div>

      {state.status === 'loading' && (
        <div className="flex justify-center py-8">
          <LoadingSpinner size="sm" fullContainer={false} />
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/20">
          <p className="text-sm text-red-700 dark:text-red-300 flex-1">{t('loadError')}</p>
          <Button variant="outline" size="sm" onClick={() => load()} className="w-full sm:w-auto">
            {t('retryButton')}
          </Button>
        </div>
      )}

      {state.status === 'ready' && state.apps.length === 0 && (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      )}

      {state.status === 'ready' && state.apps.length > 0 && (
        <ul className="space-y-3">
          {state.apps.map((app) => (
            <li
              key={app.id}
              className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium font-mono text-gray-900 dark:text-gray-100 break-all">
                  {destinationLine(app)}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-0.5 break-words">
                  {t('callsItself', { name: app.clientName })}
                </p>
                {app.scopes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    {app.scopes.map((scope) => (
                      <Badge key={scope} variant={scope === 'write' ? 'amber' : 'blue'}>
                        {scope === 'read' || scope === 'write' ? t(`scopes.${scope}`) : scope}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {[
                    app.grantedAt ? t('connectedOn', { date: formatDate(new Date(app.grantedAt)) }) : null,
                    app.lastUsedAt
                      ? t('lastUsed', { time: relativeTime(app.lastUsedAt) })
                      : t('notUsedYet'),
                    app.expiresAt ? t('expiresOn', { date: formatDate(new Date(app.expiresAt)) }) : null,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(t('separator'))}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevoking(app)}
                className="w-full sm:w-auto flex-shrink-0"
                aria-label={t('revokeAriaLabel', { name: app.clientName })}
              >
                {t('revokeButton')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={!!revoking}
        title={t('revokeModal.title')}
        message={t('revokeModal.message', { name: revoking?.clientName ?? '' })}
        confirmLabel={isRevoking ? t('revokeModal.revoking') : t('revokeModal.confirmLabel')}
        variant="danger"
        onConfirm={handleRevoke}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
}
