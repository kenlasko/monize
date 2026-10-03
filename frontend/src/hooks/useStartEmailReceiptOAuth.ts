'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import type { EmailReceiptOAuthProvider } from '@/types/email-receipts';

/**
 * The address the browser is about to be sent to must be the provider's HTTPS
 * consent page. The URL comes from our own API, but a navigation is not the
 * place to find out it was something else (`javascript:`, a plain `http:` page),
 * so anything but an `https:` URL is refused before the browser moves.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Starts the OAuth login for a provider: asks the server for the consent URL
 * and sends the browser there. On success the page unloads, so `pending` stays
 * set (a second click must not start a second flow); on failure it clears and
 * `error` names what went wrong.
 */
export function useStartEmailReceiptOAuth() {
  const t = useTranslations('emailReceipts.mailbox.oauth');
  const [pending, setPending] = useState<EmailReceiptOAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (provider: EmailReceiptOAuthProvider) => {
      setPending(provider);
      setError(null);
      try {
        const { authorizationUrl } = await emailReceiptsApi.oauth.start(provider);
        if (!isHttpsUrl(authorizationUrl)) {
          setError(t('badAuthorizationUrl'));
          setPending(null);
          return;
        }
        window.location.assign(authorizationUrl);
      } catch (err) {
        setError(getErrorMessage(err, t('startFailed')));
        setPending(null);
      }
    },
    [t],
  );

  return { start, pending, error };
}
