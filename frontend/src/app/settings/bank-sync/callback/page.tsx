'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { bankSyncApi } from '@/lib/bank-sync';
import { getErrorMessage } from '@/lib/errors';

/** The bank's own words are shown, but bounded: the server bounds them too. */
const BANK_MESSAGE_MAX_LENGTH = 300;

const SETTINGS_PATH = '/settings/bank-sync';

function CallbackContent() {
  const t = useTranslations('settings.bankSync.callback');
  const router = useRouter();
  const searchParams = useSearchParams();
  // The state is single-use at the server, so the callback must be posted
  // exactly once. The effect depends on values that are not stable across
  // renders (the translator, the search params once the query is stripped), so
  // without this guard a re-render would post a state the first pass consumed
  // and toast a failure over a connection that had just succeeded.
  const hasHandled = useRef(false);

  useEffect(() => {
    if (hasHandled.current) return;
    hasHandled.current = true;

    const state = searchParams.get('state');
    const code = searchParams.get('code');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    // The code and state are credentials in the address bar: take them out
    // before doing anything else, so they reach neither history nor a bookmark.
    window.history.replaceState(null, '', window.location.pathname);

    const finish = () => router.replace(SETTINGS_PATH);

    if (!state || (!code && !error)) {
      toast.error(t('missingState'));
      finish();
      return;
    }

    const bankErrorMessage = () =>
      t('bankError', {
        message: (errorDescription || error || '').slice(0, BANK_MESSAGE_MAX_LENGTH),
      });

    const complete = async () => {
      try {
        const { connection, linked, suggestions } = await bankSyncApi.completeCallback({
          state,
          ...(code ? { code } : {}),
          ...(error ? { error } : {}),
          ...(errorDescription ? { errorDescription } : {}),
        });

        if (error) {
          toast.error(bankErrorMessage());
        } else if (connection.status === 'active') {
          toast.success(
            connection.institutionName
              ? t('successNamed', { bank: connection.institutionName })
              : t('success'),
          );
          // The server linked every bank account whose number names exactly one
          // of the user's accounts. Say so, so the first import is not a surprise.
          if (linked.length > 0) {
            toast.success(t('autoLinked', { count: linked.length }), { duration: 8000 });
          }
          if (suggestions.length > 0) {
            toast(t('autoSuggested', { count: suggestions.length }), { duration: 8000 });
          }
        } else {
          toast.error(connection.lastError || t('notActive'));
        }
      } catch (failure) {
        // The bank's refusal is the reason worth showing, even when the server
        // could not record it.
        toast.error(error ? bankErrorMessage() : getErrorMessage(failure, t('failed')));
      } finally {
        finish();
      }
    };

    void complete();
  }, [searchParams, router, t]);

  return (
    <PageLayout>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <LoadingSpinner />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('title')}
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{t('subtitle')}</p>
        </div>
      </div>
    </PageLayout>
  );
}

export default function BankSyncCallbackPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={<LoadingSpinner />}>
        <CallbackContent />
      </Suspense>
    </ProtectedRoute>
  );
}
