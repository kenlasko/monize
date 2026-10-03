'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { MailboxSettingsFields, type MailboxSettingsValues } from '@/components/email-receipts/MailboxSettingsFields';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useStartEmailReceiptOAuth } from '@/hooks/useStartEmailReceiptOAuth';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import type {
  EmailReceiptMailbox,
  EmailReceiptOAuthProvider,
  EmailReceiptOAuthProviders,
} from '@/types/email-receipts';

/** Where the user removes the grant at the provider; Monize cannot revoke it from here. */
const PROVIDER_PERMISSIONS_URL: Record<EmailReceiptOAuthProvider, string> = {
  google: 'https://myaccount.google.com/permissions',
  microsoft: 'https://myapps.microsoft.com',
};

interface OAuthMailboxPanelProps {
  mailbox: EmailReceiptMailbox;
  /** Null while the operator's providers could not be read. */
  providers: EmailReceiptOAuthProviders | null;
  /** The mailbox after a change; null when the server no longer has one. */
  onChanged: (mailbox: EmailReceiptMailbox | null) => void;
}

/**
 * A mailbox that logs in through OAuth: who it is connected as, reconnect and
 * disconnect, and the four settings it has (saved by `PATCH /settings`, since
 * there is no host, port or password to send).
 *
 * Disconnecting deletes Monize's stored token and nothing else; the grant stays
 * at the provider until the user removes it there, so the panel says so and
 * links to the page where that is done.
 */
export function OAuthMailboxPanel({ mailbox, providers, onChanged }: OAuthMailboxPanelProps) {
  const t = useTranslations('emailReceipts.mailbox.oauth');
  const tc = useTranslations('common');
  const { start, pending, error: startError } = useStartEmailReceiptOAuth();

  const provider = mailbox.oauthProvider;
  const [baseline, setBaseline] = useState(mailbox);
  const [settings, setSettings] = useState<MailboxSettingsValues>({
    folder: mailbox.folder,
    enabled: mailbox.enabled,
    aiMode: mailbox.aiMode,
    autoApply: mailbox.autoApply,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const isDirty =
    settings.folder.trim() !== baseline.folder ||
    settings.enabled !== baseline.enabled ||
    settings.aiMode !== baseline.aiMode ||
    settings.autoApply !== baseline.autoApply;

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      // The PATCH takes any subset, so only the settings that moved are sent.
      const saved = await emailReceiptsApi.mailbox.updateSettings({
        ...(settings.folder.trim() !== baseline.folder && settings.folder.trim() !== ''
          ? { folder: settings.folder.trim() }
          : {}),
        ...(settings.enabled !== baseline.enabled ? { enabled: settings.enabled } : {}),
        ...(settings.aiMode !== baseline.aiMode ? { aiMode: settings.aiMode } : {}),
        ...(settings.autoApply !== baseline.autoApply ? { autoApply: settings.autoApply } : {}),
      });
      setBaseline(saved);
      setSettings({ folder: saved.folder, enabled: saved.enabled, aiMode: saved.aiMode, autoApply: saved.autoApply });
      onChanged(saved);
      toast.success(t('saved'));
    } catch (error) {
      setSaveError(getErrorMessage(error, t('saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    setIsDisconnecting(true);
    try {
      await emailReceiptsApi.oauth.disconnect();
      toast.success(t('disconnected'));
      onChanged(await emailReceiptsApi.mailbox.get());
    } catch (error) {
      toast.error(getErrorMessage(error, t('disconnectFailed')));
    } finally {
      setIsDisconnecting(false);
    }
  };

  // Reconnecting needs the operator's client for that provider. Unknown (the
  // providers lookup failed) still offers it: the server refuses if it cannot.
  const canReconnect = provider !== null && providers?.[provider] !== false;
  const providerName = provider ? t(`providerNames.${provider}`) : '';

  return (
    <div className="space-y-4">
      {mailbox.oauthConnected ? (
        <p role="status" className="text-sm text-gray-900 dark:text-gray-100">
          {t('connectedAs', { provider: providerName, username: mailbox.username })}
        </p>
      ) : (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
          {t('notConnected', { provider: providerName })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canReconnect && provider && (
          <Button
            variant="outline"
            isLoading={pending === provider}
            disabled={pending !== null || isDisconnecting}
            onClick={() => void start(provider)}
          >
            {t('reconnect')}
          </Button>
        )}
        {mailbox.oauthConnected && (
          <Button
            variant="outline"
            isLoading={isDisconnecting}
            disabled={pending !== null}
            onClick={() => setConfirmDisconnect(true)}
          >
            {t('disconnect')}
          </Button>
        )}
      </div>
      {startError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {startError}
        </p>
      )}

      {provider && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('revokeNote', { provider: providerName })}{' '}
          <a
            href={PROVIDER_PERMISSIONS_URL[provider]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t(`revokeLink.${provider}`)}
          </a>
        </p>
      )}

      <MailboxSettingsFields idPrefix="email-receipts-oauth" values={settings} onChange={setSettings} />

      {saveError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}
      <Button isLoading={isSaving} disabled={!isDirty} onClick={() => void handleSave()}>
        {t('saveButton')}
      </Button>

      <ConfirmDialog
        isOpen={confirmDisconnect}
        title={t('disconnectDialog.title')}
        message={t('disconnectDialog.message', { provider: providerName })}
        confirmLabel={t('disconnect')}
        cancelLabel={tc('cancel')}
        variant="warning"
        onConfirm={() => void handleDisconnect()}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}
