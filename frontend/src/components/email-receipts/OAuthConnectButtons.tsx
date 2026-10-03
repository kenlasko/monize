'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useStartEmailReceiptOAuth } from '@/hooks/useStartEmailReceiptOAuth';
import {
  EMAIL_RECEIPT_OAUTH_PROVIDERS,
  type EmailReceiptOAuthProviders,
} from '@/types/email-receipts';

interface OAuthConnectButtonsProps {
  providers: EmailReceiptOAuthProviders;
}

/**
 * "Connect with Google" / "Connect with Microsoft", one button per provider the
 * operator configured. Renders nothing when neither is, so the manual form is
 * the only way in and there is no dead control.
 */
export function OAuthConnectButtons({ providers }: OAuthConnectButtonsProps) {
  const t = useTranslations('emailReceipts.mailbox.oauth');
  const { start, pending, error } = useStartEmailReceiptOAuth();

  const offered = EMAIL_RECEIPT_OAUTH_PROVIDERS.filter((provider) => providers[provider]);
  if (offered.length === 0) return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('heading')}</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('explanation')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {offered.map((provider) => (
          <Button
            key={provider}
            variant="outline"
            isLoading={pending === provider}
            disabled={pending !== null}
            onClick={() => void start(provider)}
          >
            {t(`connect.${provider}`)}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
