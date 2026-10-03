'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import type { EmailReceiptMailbox } from '@/types/email-receipts';

const SETTINGS_HREF = '/settings/email-receipts';

/** A provider's own words are shown, but never more than a sentence or two of them. */
const PROVIDER_TEXT_MAX_LENGTH = 300;

type Completion =
  | { status: 'success'; mailbox: EmailReceiptMailbox }
  | { status: 'failed'; error: unknown };

export default function EmailReceiptsOAuthCallbackPage() {
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <Suspense fallback={<LoadingSpinner />}>
            <OAuthCallbackContent />
          </Suspense>
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}

/**
 * Where Google or Microsoft sends the browser back to. It reads `code` and
 * `state` (or the provider's `error`), posts them once to
 * `POST /email-receipts/mailbox/oauth/complete`, and says what happened: it is
 * never a blank page, and a failure names the reason and the way back.
 *
 * The code is single use, so the POST is issued exactly once however many times
 * the effect runs (React strict mode runs it twice on mount): the request is
 * created under a ref and every run only subscribes to it. The code and state
 * are taken out of the address bar as soon as they are read, so neither stays
 * in the browser history.
 */
function OAuthCallbackContent() {
  const t = useTranslations('emailReceipts.callback');
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read once. The address bar is scrubbed below, and `useSearchParams` follows
  // `history.replaceState`, so reading it live would turn a pending connection
  // into "missing parameters" the moment the scrub ran.
  const [params] = useState(() => ({
    providerError: searchParams.get('error'),
    providerErrorDescription: searchParams.get('error_description'),
    code: searchParams.get('code'),
    state: searchParams.get('state'),
  }));
  const { providerError, providerErrorDescription, code, state } = params;
  const hasParameters = code !== null && code !== '' && state !== null && state !== '';
  const shouldComplete = providerError === null && hasParameters;

  const [completion, setCompletion] = useState<Completion | null>(null);
  const request = useRef<Promise<EmailReceiptMailbox> | null>(null);
  // The translator and the router are not guaranteed to keep their identity
  // from one render to the next, and an effect that depended on them would run
  // again (and set state again) on every render. The effect reads the latest
  // through this ref instead and depends only on what identifies the request.
  const latest = useRef({ router, connectedToast: t('toasts.connected') });
  useEffect(() => {
    latest.current = { router, connectedToast: t('toasts.connected') };
  });

  useEffect(() => {
    if (!shouldComplete || code === null || state === null) return;
    request.current ??= emailReceiptsApi.oauth.complete(code, state);
    window.history.replaceState(null, '', window.location.pathname);

    let cancelled = false;
    request.current.then(
      (mailbox) => {
        if (cancelled) return;
        setCompletion({ status: 'success', mailbox });
        toast.success(latest.current.connectedToast);
        latest.current.router.replace(SETTINGS_HREF);
      },
      (error: unknown) => {
        if (cancelled) return;
        setCompletion({ status: 'failed', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shouldComplete, code, state]);

  let body;
  if (providerError !== null) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('providerError.title')}
          description={
            providerErrorDescription
              ? t('providerError.withDescription', {
                  error: providerError.slice(0, PROVIDER_TEXT_MAX_LENGTH),
                  description: providerErrorDescription.slice(0, PROVIDER_TEXT_MAX_LENGTH),
                })
              : t('providerError.withoutDescription', { error: providerError.slice(0, PROVIDER_TEXT_MAX_LENGTH) })
          }
        />
      </div>
    );
  } else if (!hasParameters) {
    body = (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('missingParameters.title')}
          description={t('missingParameters.body')}
        />
      </div>
    );
  } else if (completion?.status === 'failed') {
    body = (
      <div role="alert">
        <EmptyState icon={<ExclamationTriangleIcon />} title={t('failed.title')} description={getErrorMessage(completion.error, t('failed.fallback'))} />
      </div>
    );
  } else if (completion?.status === 'success') {
    body = (
      <div role="status">
        <EmptyState
          icon={<CheckCircleIcon />}
          title={t('success.title')}
          description={t('success.body', { username: completion.mailbox.username })}
        />
      </div>
    );
  } else {
    body = <LoadingSpinner text={t('connecting')} />;
  }

  const finished = providerError !== null || !hasParameters || completion !== null;

  return (
    <>
      <PageHeader title={t('title')} />
      <Card padding="md">{body}</Card>
      {finished && (
        <p className="mt-4 text-sm">
          <Link href={SETTINGS_HREF} className="text-blue-600 dark:text-blue-400 hover:underline">
            {t('backLink')}
          </Link>
        </p>
      )}
    </>
  );
}
