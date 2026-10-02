'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { BankSyncConnectDialog } from '@/components/settings/bank-sync/BankSyncConnectDialog';
import { BankSyncConnectionCard } from '@/components/settings/bank-sync/BankSyncConnectionCard';
import { BankSyncCredentialsCard } from '@/components/settings/bank-sync/BankSyncCredentialsCard';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDemoMode } from '@/hooks/useDemoMode';
import { accountsApi } from '@/lib/accounts';
import { bankSyncApi } from '@/lib/bank-sync';
import type { Account } from '@/types/account';
import type { BankSyncConnection, BankSyncStatus } from '@/types/bank-sync';

export default function BankSyncSettingsPage() {
  return (
    <ProtectedRoute>
      <BankSyncSettingsContent />
    </ProtectedRoute>
  );
}

/** One read of the page: settled, with its answer or with the fact it failed. */
type Loaded<T> =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; data: T };

interface ConnectionsData {
  connections: BankSyncConnection[];
  accounts: Account[];
}

function BankSyncSettingsContent() {
  const t = useTranslations('settings.bankSync');
  const isDemoMode = useDemoMode();
  const [status, setStatus] = useState<Loaded<BankSyncStatus>>({ state: 'loading' });
  const [connections, setConnections] = useState<Loaded<ConnectionsData>>({ state: 'loading' });
  const [showConnect, setShowConnect] = useState(false);
  // Guards a reload against an older one landing after it.
  const connectionsRequest = useRef(0);

  const loadStatus = useCallback(
    () =>
      bankSyncApi
        .getStatus()
        .then((data) => setStatus({ state: 'ready', data }))
        .catch(() => setStatus({ state: 'failed' })),
    [],
  );

  // The accounts are read with the connections because the link picker needs
  // both: a connection list without the accounts to link it to is a list whose
  // controls cannot work, so either failing is one failure with one retry.
  const loadConnections = useCallback(() => {
    const request = ++connectionsRequest.current;
    return Promise.all([bankSyncApi.listConnections(), accountsApi.getAll()])
      .then(([connectionList, accounts]) => {
        if (request !== connectionsRequest.current) return;
        setConnections({
          state: 'ready',
          data: { connections: connectionList, accounts },
        });
      })
      .catch(() => {
        if (request !== connectionsRequest.current) return;
        setConnections({ state: 'failed' });
      });
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadConnections();
  }, [loadStatus, loadConnections]);

  const retryStatus = () => {
    setStatus({ state: 'loading' });
    void loadStatus();
  };
  const retryConnections = () => {
    setConnections({ state: 'loading' });
    void loadConnections();
  };

  // A reload after a write keeps the rows on screen instead of blanking them.
  const reloadConnections = useCallback(() => loadConnections(), [loadConnections]);

  const linkedAccountIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    if (connections.state === 'ready') {
      for (const connection of connections.data.connections) {
        for (const bankAccount of connection.accounts) {
          if (bankAccount.accountId) ids.add(bankAccount.accountId);
        }
      }
    }
    return ids;
  }, [connections]);

  const credentialsReady =
    status.state === 'ready' && status.data.credentials?.privateKeySet === true;

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="mb-4">
          <Link
            href="/settings"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            &larr; {t('backLink')}
          </Link>
        </div>

        <PageHeader title={t('title')} subtitle={t('subtitle')} />

        {isDemoMode && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('demoRestricted.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('demoRestricted.body')}
            </p>
          </div>
        )}

        {status.state === 'loading' && <LoadingSpinner />}
        {status.state === 'failed' && (
          <LoadFailedCard
            title={t('loadFailed.title')}
            retryLabel={t('loadFailed.retry')}
            onRetry={retryStatus}
          />
        )}
        {status.state === 'ready' && (
          <BankSyncCredentialsCard
            status={status.data}
            disabled={isDemoMode}
            onStatusChange={(next) => setStatus({ state: 'ready', data: next })}
          />
        )}

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('connections.title')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('connections.subtitle')}
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setShowConnect(true)}
            disabled={isDemoMode || !credentialsReady}
          >
            {t('connections.connect')}
          </Button>
        </div>
        {status.state === 'ready' && !credentialsReady && (
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('connections.credentialsFirst')}
          </p>
        )}

        {connections.state === 'loading' && <LoadingSpinner />}
        {connections.state === 'failed' && (
          <LoadFailedCard
            title={t('connections.loadFailed')}
            retryLabel={t('loadFailed.retry')}
            onRetry={retryConnections}
          />
        )}
        {connections.state === 'ready' &&
          (connections.data.connections.length === 0 ? (
            <Card padding="md">
              <EmptyState
                title={t('connections.empty.title')}
                description={t('connections.empty.description')}
              />
            </Card>
          ) : (
            connections.data.connections.map((connection) => (
              <BankSyncConnectionCard
                key={connection.id}
                connection={connection}
                accounts={connections.data.accounts}
                linkedAccountIds={linkedAccountIds}
                disabled={isDemoMode}
                onChanged={reloadConnections}
              />
            ))
          ))}

        {showConnect && (
          <BankSyncConnectDialog
            isOpen={showConnect}
            onClose={() => setShowConnect(false)}
          />
        )}
      </main>
    </PageLayout>
  );
}

function LoadFailedCard({
  title,
  retryLabel,
  onRetry,
}: {
  title: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <Card padding="md" className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {title}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      </div>
    </Card>
  );
}
