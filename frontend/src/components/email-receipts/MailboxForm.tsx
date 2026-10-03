'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { MailboxSettingsFields, type MailboxSettingsValues } from '@/components/email-receipts/MailboxSettingsFields';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { emailReceiptsApi } from '@/lib/email-receipts-api';
import { getErrorMessage } from '@/lib/errors';
import {
  EMAIL_RECEIPT_MAILBOX_SECURITIES,
  type EmailReceiptMailbox,
  type EmailReceiptMailboxSecurity,
  type EmailReceiptMailboxTestResult,
  type TestEmailReceiptMailboxPayload,
  type UpsertEmailReceiptMailboxPayload,
} from '@/types/email-receipts';

const DEFAULT_PORT_BY_SECURITY: Record<EmailReceiptMailboxSecurity, number> = { tls: 993, starttls: 143 };

interface MailboxFormProps {
  /** The stored mailbox, read once when the form mounts; null while none is saved. */
  mailbox: EmailReceiptMailbox | null;
  onSaved: (mailbox: EmailReceiptMailbox) => void;
}

/**
 * The manual (password) mailbox form.
 *
 * **The password is write-only.** The server reports only `passwordSet`, so the
 * box is empty on every load and on every re-baseline, carries a placeholder
 * saying one is stored, and is sent only when the user typed something: a blank
 * box means "keep the stored one", never "clear it". It is required only where
 * the server requires it (a new mailbox, or a changed host or user name, since
 * the stored password belongs to the old login).
 *
 * The form owns its baseline (`view`) rather than reading the parent's latest
 * mailbox, so a poll that refreshes the parent's status line cannot wipe what
 * the user is typing.
 */
export function MailboxForm({ mailbox, onSaved }: MailboxFormProps) {
  const t = useTranslations('emailReceipts.mailbox.form');
  const [view, setView] = useState<EmailReceiptMailbox | null>(mailbox);

  const [host, setHost] = useState(mailbox?.host ?? '');
  const [port, setPort] = useState<number | undefined>(mailbox?.port ?? DEFAULT_PORT_BY_SECURITY.tls);
  const [security, setSecurity] = useState<EmailReceiptMailboxSecurity>(mailbox?.security ?? 'tls');
  const [username, setUsername] = useState(mailbox?.username ?? '');
  const [password, setPassword] = useState('');
  const [settings, setSettings] = useState<MailboxSettingsValues>({
    folder: mailbox?.folder ?? 'INBOX',
    enabled: mailbox?.enabled ?? false,
    aiMode: mailbox?.aiMode ?? 'off',
    autoApply: mailbox?.autoApply ?? false,
  });

  const [isSaving, setIsSaving] = useState(false);
  // The server names what it refused (a private host, a missing password); that
  // belongs beside the fields it describes, not in a toast that is gone in
  // seconds.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<EmailReceiptMailboxTestResult | null>(null);

  const passwordRequired = view === null || host.trim() !== view.host || username.trim() !== view.username;
  const hasLogin = host.trim() !== '' && port !== undefined && username.trim() !== '';
  const isDirty =
    view === null ||
    password !== '' ||
    host.trim() !== view.host ||
    port !== view.port ||
    security !== view.security ||
    username.trim() !== view.username ||
    settings.folder.trim() !== view.folder ||
    settings.enabled !== view.enabled ||
    settings.aiMode !== view.aiMode ||
    settings.autoApply !== view.autoApply;
  const canSave = hasLogin && isDirty && !(passwordRequired && password === '');

  const applyView = (next: EmailReceiptMailbox) => {
    setView(next);
    setHost(next.host);
    setPort(next.port);
    setSecurity(next.security);
    setUsername(next.username);
    // What came back says only that a secret is stored; keeping what was typed
    // in the box would make the next save resend it.
    setPassword('');
    setSettings({ folder: next.folder, enabled: next.enabled, aiMode: next.aiMode, autoApply: next.autoApply });
  };

  const handleSave = async () => {
    if (port === undefined) return;
    const payload: UpsertEmailReceiptMailboxPayload = {
      host: host.trim(),
      port,
      security,
      username: username.trim(),
      ...(password !== '' ? { password } : {}),
      ...(settings.folder.trim() !== '' ? { folder: settings.folder.trim() } : {}),
      enabled: settings.enabled,
      aiMode: settings.aiMode,
      autoApply: settings.autoApply,
    };
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await emailReceiptsApi.mailbox.upsert(payload);
      applyView(saved);
      onSaved(saved);
      setTestResult(null);
      toast.success(t('saved'));
    } catch (error) {
      setSaveError(getErrorMessage(error, t('saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (port === undefined) return;
    const payload: TestEmailReceiptMailboxPayload = {
      host: host.trim(),
      port,
      security,
      username: username.trim(),
      ...(password !== '' ? { password } : {}),
      ...(settings.folder.trim() !== '' ? { folder: settings.folder.trim() } : {}),
    };
    setIsTesting(true);
    setTestResult(null);
    try {
      setTestResult(await emailReceiptsApi.mailbox.test(payload));
    } catch (error) {
      setTestResult({ ok: false, error: getErrorMessage(error, t('test.failed')) });
    } finally {
      setIsTesting(false);
    }
  };

  const securityOptions = EMAIL_RECEIPT_MAILBOX_SECURITIES.map((value) => ({
    value,
    label: t(`securityOptions.${value}`),
  }));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !isSaving) void handleSave();
      }}
    >
      <p className="text-sm text-gray-600 dark:text-gray-400">{t('intro')}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          id="email-receipts-host"
          label={t('hostLabel')}
          value={host}
          maxLength={255}
          autoComplete="off"
          placeholder="imap.example.com"
          onChange={(e) => setHost(e.target.value)}
        />
        <NumericInput
          id="email-receipts-port"
          label={t('portLabel')}
          value={port}
          decimalPlaces={0}
          max={65535}
          onChange={setPort}
        />
        <Select
          id="email-receipts-security"
          label={t('securityLabel')}
          value={security}
          options={securityOptions}
          onChange={(e) => {
            const next = e.target.value as EmailReceiptMailboxSecurity;
            // Follow the conventional port only while the port is still the
            // other mode's default, so a custom port is never overwritten.
            if (port === DEFAULT_PORT_BY_SECURITY[security]) setPort(DEFAULT_PORT_BY_SECURITY[next]);
            setSecurity(next);
          }}
        />
        <Input
          id="email-receipts-username"
          label={t('usernameLabel')}
          value={username}
          maxLength={320}
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>

      <div>
        <Input
          id="email-receipts-password"
          label={t('passwordLabel')}
          type="password"
          // Not a credential of this site: an autofilled Monize password here
          // would be stored as the mailbox's password and every poll would fail.
          autoComplete="off"
          value={password}
          maxLength={1000}
          placeholder={view?.passwordSet ? t('passwordStoredPlaceholder') : undefined}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {passwordRequired ? t('passwordRequiredHelp') : t('passwordKeepHelp')}
        </p>
      </div>

      <MailboxSettingsFields idPrefix="email-receipts" values={settings} onChange={setSettings} />

      {saveError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" isLoading={isSaving} disabled={!canSave}>
          {t('saveButton')}
        </Button>
        <Button
          type="button"
          variant="outline"
          isLoading={isTesting}
          disabled={!hasLogin || (passwordRequired && password === '' && view === null)}
          onClick={() => void handleTest()}
        >
          {t('test.button')}
        </Button>
      </div>

      {testResult && testResult.ok && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {t('test.ok', { count: testResult.messages })}
        </p>
      )}
      {testResult && !testResult.ok && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('test.error', { error: testResult.error })}
        </p>
      )}
    </form>
  );
}
