'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { MailboxForm } from '@/components/email-receipts/MailboxForm';
import { MailboxStatus } from '@/components/email-receipts/MailboxStatus';
import { OAuthConnectButtons } from '@/components/email-receipts/OAuthConnectButtons';
import { OAuthMailboxPanel } from '@/components/email-receipts/OAuthMailboxPanel';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { createLogger } from '@/lib/logger';
import type { EmailReceiptMailbox, EmailReceiptOAuthProviders } from '@/types/email-receipts';

const logger = createLogger('EmailReceiptsMailbox');

type MailboxState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      mailbox: EmailReceiptMailbox | null;
      /** Null when the providers lookup failed: unknown, not "none configured". */
      providers: EmailReceiptOAuthProviders | null;
    };

/**
 * The mailbox half of `/settings/email-receipts`. Loads the mailbox and the
 * operator's OAuth providers, and tells "no mailbox" (an empty, loaded answer)
 * apart from "the request failed" (an error with a retry), so a failed read can
 * never invite the reader to set up a mailbox they already have.
 */
export function MailboxSection() {
  const t = useTranslations('emailReceipts.mailbox');
  const [state, setState] = useState<MailboxState>({ status: 'loading' });
  // Bumped by the retry button; each value is one request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      emailReceiptsApi.mailbox.get(),
      emailReceiptsApi.oauth.providers().catch((error) => {
        logger.error(error);
        return null;
      }),
    ])
      .then(([mailbox, providers]) => {
        if (!cancelled) setState({ status: 'ready', mailbox, providers });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const setMailbox = (mailbox: EmailReceiptMailbox | null) =>
    setState((prev) => (prev.status === 'ready' ? { ...prev, mailbox } : prev));

  let body;
  if (state.status === 'error') {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('error.title')}
          description={t('error.body')}
          action={
            <Button
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t('error.retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (state.status === 'loading') {
    body = <LoadingSpinner text={t('loading')} />;
  } else {
    const { mailbox, providers } = state;
    const isOAuth = mailbox?.authMethod === 'oauth2';
    body = (
      <div className="space-y-6">
        <p
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        >
          {t('dedicatedWarning')}
        </p>

        {mailbox && !mailbox.encryptionConfigured && (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
          >
            {t('encryptionUnavailable')}
          </p>
        )}

        {mailbox && <MailboxStatus mailbox={mailbox} onRefreshed={setMailbox} onDeleted={() => setMailbox(null)} />}

        {isOAuth && mailbox ? (
          <OAuthMailboxPanel mailbox={mailbox} providers={providers} onChanged={setMailbox} />
        ) : (
          <>
            {providers === null && (
              <p role="status" className="text-sm text-gray-500 dark:text-gray-400">
                {t('oauth.providersUnavailable')}
              </p>
            )}
            {providers && <OAuthConnectButtons providers={providers} />}
            <MailboxForm key={mailbox?.id ?? 'new'} mailbox={mailbox} onSaved={setMailbox} />
          </>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="email-receipts-mailbox-heading" className="mb-8">
      <h2 id="email-receipts-mailbox-heading" className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('heading')}
      </h2>
      <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">{t('description')}</p>
      <Card padding="md">{body}</Card>
    </section>
  );
}
