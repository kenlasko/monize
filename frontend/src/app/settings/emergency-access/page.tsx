'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { StepUpAuthModal } from '@/components/auth/StepUpAuthModal';
import {
  StepUpRequiredError,
  consumeOidcStepUpPending,
  consumeOidcReauthArtifact,
  useStepUpTokenStore,
} from '@/lib/stepUpToken';
import apiClient from '@/lib/api';
import { useDemoMode } from '@/hooks/useDemoMode';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { authApi } from '@/lib/auth';
import type { User } from '@/types/auth';
import {
  resolveTimezone,
  isoToDatetimeLocal,
  formatDatetimeLocal,
} from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { emergencyAccessApi } from '@/lib/emergency-access';
import type {
  EmergencyAccessContact,
  EmergencyAccessView,
} from '@/types/emergency-access';

const logger = createLogger('EmergencyAccess');
const STEP_UP_PURPOSE = 'emergency-access';

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    grantAfterDays: z
      .number()
      .int('Whole days only')
      .min(2, 'Must be at least 2 days')
      .max(365, 'Must be 365 days or fewer'),
    reminderAfterDays: z
      .number()
      .int('Whole days only')
      .min(1, 'Must be at least 1 day')
      .max(364, 'Must be 364 days or fewer'),
  })
  .refine((data) => data.reminderAfterDays < data.grantAfterDays, {
    message: 'Reminder days must be less than grant days',
    path: ['reminderAfterDays'],
  });

type SettingsFormData = z.infer<typeof settingsSchema>;

const messageSchema = z.object({
  message: z
    .string()
    .max(4000, 'Message must be 4000 characters or less')
    .optional(),
});

type MessageFormData = z.infer<typeof messageSchema>;

const contactSchema = z.object({
  firstName: z
    .string()
    .min(1, 'First name is required')
    .max(100, 'First name must be 100 characters or less'),
  email: z
    .string()
    .email('Enter a valid email address')
    .max(255, 'Email must be 255 characters or less'),
});

type ContactFormData = z.infer<typeof contactSchema>;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function formatTimestamp(
  iso: string | null,
  timezone: string,
  dateFormat: string,
  timeFormat: '24h' | '12h',
): string {
  if (!iso) return '';
  return formatDatetimeLocal(
    isoToDatetimeLocal(iso, timezone),
    dateFormat,
    timeFormat,
  );
}

export default function EmergencyAccessPage() {
  return (
    <ProtectedRoute>
      <EmergencyAccessContent />
    </ProtectedRoute>
  );
}

function EmergencyAccessContent() {
  const t = useTranslations('settings.emergencyAccess');
  const isDemoMode = useDemoMode();
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);

  if (isDelegateView || isDemoMode) {
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
          <PageHeader title={t('title')} />
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {isDelegateView
                ? t('delegateRestricted')
                : t('demoRestricted')}
            </p>
          </div>
        </main>
      </PageLayout>
    );
  }

  return <EmergencyAccessSection />;
}

// Subscribe to the current wall-clock time so the countdown re-renders once
// per second. useSyncExternalStore is the React-blessed primitive for "live
// data from outside React" -- it avoids the setState-in-effect anti-pattern
// while still keeping the value fresh.
function useNowEverySecond(enabled: boolean): number | null {
  return useSyncExternalStore(
    (cb) => {
      if (!enabled) return () => {};
      const id = window.setInterval(cb, 1000);
      return () => window.clearInterval(id);
    },
    () => (enabled ? Date.now() : null),
    () => null,
  );
}

function MessageCountdown() {
  const t = useTranslations('settings.emergencyAccess.message');
  const expiresAt = useStepUpTokenStore((s) =>
    s.getExpiresAt(STEP_UP_PURPOSE),
  );
  const now = useNowEverySecond(!!expiresAt);

  if (!expiresAt || now === null) return null;
  const remainingMs = Math.max(0, expiresAt - now);
  const mins = Math.floor(remainingMs / 60_000);
  const secs = Math.floor((remainingMs % 60_000) / 1000);
  return (
    <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
      {t('unlockTimer', { mins, secs: secs.toString().padStart(2, '0') })}
    </span>
  );
}

function EmergencyAccessSection() {
  const t = useTranslations('settings.emergencyAccess');
  const tMsg = useTranslations('settings.emergencyAccess.message');
  const tContacts = useTranslations('settings.emergencyAccess.contacts');
  const tStatus = useTranslations('settings.emergencyAccess.status');
  const tc = useTranslations('common');
  const preferences = usePreferencesStore((s) => s.preferences);
  const userTimezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat: '24h' | '12h' = preferences?.timeFormat ?? '24h';

  const hasStepUpToken = useStepUpTokenStore(
    (s) => !!s.getValid(STEP_UP_PURPOSE),
  );
  const clearStepUp = useStepUpTokenStore((s) => s.clear);

  const [view, setView] = useState<EmergencyAccessView | null>(null);
  const [loading, setLoading] = useState(true);
  // The auth store's cached user comes from /auth/profile which omits
  // authProvider + passwordHash (see getUserStateById). The step-up modal
  // needs both, so we fetch the full self profile via /auth/me-self here.
  const [selfUser, setSelfUser] = useState<User | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Message reveal/edit state
  const [messageMode, setMessageMode] = useState<'hidden' | 'view' | 'edit'>(
    'hidden',
  );
  const [messageLoading, setMessageLoading] = useState(false);
  const [savingMessage, setSavingMessage] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  // Captures which mode the user wanted -- we resume it after verification.
  const [pendingMode, setPendingMode] = useState<'view' | 'edit' | null>(null);

  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContact, setEditingContact] =
    useState<EmergencyAccessContact | null>(null);
  const [submittingContact, setSubmittingContact] = useState(false);

  const [removeTarget, setRemoveTarget] =
    useState<EmergencyAccessContact | null>(null);
  const [removing, setRemoving] = useState(false);

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  const settingsForm = useForm<SettingsFormData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      enabled: false,
      grantAfterDays: 14,
      reminderAfterDays: 7,
    },
  });

  const messageForm = useForm<MessageFormData>({
    resolver: zodResolver(messageSchema),
    defaultValues: { message: '' },
  });

  const contactForm = useForm<ContactFormData>({
    resolver: zodResolver(contactSchema),
    defaultValues: { firstName: '', email: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await emergencyAccessApi.get();
      setView(data);
      settingsForm.reset({
        enabled: data.enabled,
        grantAfterDays: data.grantAfterDays,
        reminderAfterDays: data.reminderAfterDays,
      });
    } catch (err) {
      toast.error(getErrorMessage(err, t('toasts.loadFailed')));
      logger.error(err);
    } finally {
      setLoading(false);
    }
  }, [settingsForm, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the full self profile so the step-up modal can pick the right
  // factor (authProvider + hasPassword aren't on the auth-store user).
  useEffect(() => {
    authApi
      .getSelfProfile()
      .then((u) => setSelfUser(u))
      .catch((err) => {
        logger.error('Failed to load self profile for step-up', err);
      });
  }, []);

  // Lock the message view whenever the step-up token disappears (expiry, "Lock now",
  // logout). This prevents stale plaintext from staying on-screen after the
  // unlock window ends.
  useEffect(() => {
    if (!hasStepUpToken && messageMode !== 'hidden') {
      setMessageMode('hidden');
      messageForm.reset({ message: '' });
    }
  }, [hasStepUpToken, messageMode, messageForm]);

  // Finalize step-up after an OIDC roundtrip. The user clicked "Continue to
  // identity provider" in the modal, which stashed the pending purpose +
  // mode in sessionStorage and called authApi.initiateOidc(). The auth
  // callback brought them back here. Read the sentinel, exchange it for a
  // real step-up token, and resume the action they wanted.
  useEffect(() => {
    const pending = consumeOidcStepUpPending(STEP_UP_PURPOSE);
    if (!pending) return;
    const resumeMode = pending.payload?.mode as 'view' | 'edit' | undefined;
    (async () => {
      try {
        // The artifact the OIDC callback minted, not a claim that the round
        // trip happened: the endpoint verifies its signature, purpose and
        // subject, and spends it (P2-005).
        const artifact = consumeOidcReauthArtifact();
        const res = await apiClient.post<{
          stepUpToken: string;
          expiresAt: string;
        }>('/auth/step-up', {
          purpose: STEP_UP_PURPOSE,
          oidcReauthToken: artifact ?? undefined,
        });
        useStepUpTokenStore
          .getState()
          .set(STEP_UP_PURPOSE, res.data.stepUpToken, res.data.expiresAt);
        if (resumeMode === 'view' || resumeMode === 'edit') {
          setPendingMode(resumeMode);
          // Defer to next tick so the token is in the store before fetch.
          queueMicrotask(() => {
            void fetchMessageInto(resumeMode);
          });
        }
      } catch (err) {
        toast.error(getErrorMessage(err, t('toasts.reauthFailed')));
        logger.error(err);
      }
    })();
    // Intentionally run once per mount -- the sentinel is consumed on the
    // first call, so re-runs would no-op anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMessageInto = useCallback(
    async (nextMode: 'view' | 'edit') => {
      setMessageLoading(true);
      try {
        const { message } = await emergencyAccessApi.getMessage();
        messageForm.reset({ message: message ?? '' });
        setMessageMode(nextMode);
      } catch (err) {
        if (err instanceof StepUpRequiredError) {
          clearStepUp(STEP_UP_PURPOSE);
          setPendingMode(nextMode);
          setStepUpOpen(true);
          return;
        }
        toast.error(getErrorMessage(err, tMsg('toasts.loadFailed')));
        logger.error(err);
      } finally {
        setMessageLoading(false);
      }
    },
    [messageForm, clearStepUp, tMsg],
  );

  const handleReveal = () => {
    if (!hasStepUpToken) {
      setPendingMode('view');
      setStepUpOpen(true);
      return;
    }
    void fetchMessageInto('view');
  };

  const handleEdit = () => {
    if (!hasStepUpToken) {
      setPendingMode('edit');
      setStepUpOpen(true);
      return;
    }
    void fetchMessageInto('edit');
  };

  const handleLockNow = () => {
    clearStepUp(STEP_UP_PURPOSE);
    setMessageMode('hidden');
    messageForm.reset({ message: '' });
  };

  const onMessageSubmit = async (data: MessageFormData) => {
    setSavingMessage(true);
    try {
      const meta = await emergencyAccessApi.updateMessage(
        data.message?.trim() ? data.message.trim() : null,
      );
      setView((prev) =>
        prev ? { ...prev, messageMetadata: { ...meta, updatedAt: meta.updatedAt ? String(meta.updatedAt) : null } } : prev,
      );
      toast.success(tMsg('toasts.saved'));
      setMessageMode('view');
    } catch (err) {
      if (err instanceof StepUpRequiredError) {
        // Token expired between fetch and save -- re-prompt and ask the user
        // to click Save again.
        clearStepUp(STEP_UP_PURPOSE);
        setStepUpOpen(true);
        toast.error(tMsg('toasts.verifyAgain'));
        return;
      }
      toast.error(getErrorMessage(err, tMsg('toasts.saveFailed')));
      logger.error(err);
    } finally {
      setSavingMessage(false);
    }
  };

  const onSettingsSubmit = async (data: SettingsFormData) => {
    setSavingSettings(true);
    try {
      const next = await emergencyAccessApi.updateSettings(data);
      setView(next);
      toast.success(t('settings.toasts.saved'));
    } catch (err) {
      toast.error(getErrorMessage(err, t('settings.toasts.saveFailed')));
      logger.error(err);
    } finally {
      setSavingSettings(false);
    }
  };

  const openCreateContact = () => {
    setEditingContact(null);
    contactForm.reset({ firstName: '', email: '' });
    setShowContactForm(true);
  };

  const openEditContact = (contact: EmergencyAccessContact) => {
    setEditingContact(contact);
    contactForm.reset({
      firstName: contact.firstName,
      email: contact.email,
    });
    setShowContactForm(true);
  };

  const onContactSubmit = async (data: ContactFormData) => {
    setSubmittingContact(true);
    try {
      const saved = editingContact
        ? await emergencyAccessApi.updateContact(editingContact.id, data)
        : await emergencyAccessApi.addContact(data);
      setView((prev) => {
        if (!prev) return prev;
        const contacts = editingContact
          ? prev.contacts.map((c) => (c.id === saved.id ? saved : c))
          : [...prev.contacts, saved];
        return { ...prev, contacts };
      });
      toast.success(editingContact ? tContacts('toasts.updated') : tContacts('toasts.added'));
      setShowContactForm(false);
    } catch (err) {
      toast.error(getErrorMessage(err, tContacts('toasts.saveFailed')));
      logger.error(err);
    } finally {
      setSubmittingContact(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await emergencyAccessApi.removeContact(removeTarget.id);
      setView((prev) =>
        prev
          ? {
              ...prev,
              contacts: prev.contacts.filter((c) => c.id !== removeTarget.id),
            }
          : prev,
      );
      toast.success(tContacts('toasts.removed'));
      setRemoveTarget(null);
    } catch (err) {
      toast.error(getErrorMessage(err, tContacts('toasts.removeFailed')));
      logger.error(err);
    } finally {
      setRemoving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const next = await emergencyAccessApi.reset();
      setView(next);
      toast.success(t('resetConfirm.toasts.cleared'));
      setShowResetConfirm(false);
    } catch (err) {
      toast.error(getErrorMessage(err, t('resetConfirm.toasts.resetFailed')));
      logger.error(err);
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <PageLayout>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className="flex justify-center items-center h-64">
            <LoadingSpinner />
          </div>
        </main>
      </PageLayout>
    );
  }

  if (!view) {
    return (
      <PageLayout>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader title={t('title')} />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('loadError')}
          </p>
        </main>
      </PageLayout>
    );
  }

  const inactiveDays = daysSince(view.lastActivityAt);
  const enabledNow = settingsForm.watch('enabled');
  const { messageMetadata } = view;

  // Arming needs both dependencies; disabling needs neither. A feature already
  // enabled must stay switch-off-able even when SMTP or the encryption key is
  // missing -- that is how an owner revokes it after a dependency was removed
  // (audit V4R3-002). So the settings controls are live whenever the feature can
  // be armed OR is currently stored as enabled, and the toggle clamps to "off"
  // while it cannot be armed.
  //
  // The waiting periods are gated on `canArmFeature` rather than on
  // `canEditSettings`: on a degraded install the only useful thing to submit is
  // `enabled: false`, and the server refuses anything else with a 503. Leaving them
  // live invites a save that can only fail.
  const canArmFeature =
    view.emailConfigured && view.credentialEncryptionConfigured;
  const canEditSettings = canArmFeature || view.enabled;

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

        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
        />

        {!view.emailConfigured && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('emailNotConfigured.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('emailNotConfigured.body')}
            </p>
          </div>
        )}

        {/*
          Not gated on `emailConfigured`. The two dependencies fail independently,
          which is the whole argument for showing this notice at all -- so an install
          missing both has to be told both, rather than being sent to fix SMTP and
          only then discovering the second one on the next page load.
        */}
        {!view.credentialEncryptionConfigured && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              {t('encryptionNotConfigured.heading')}
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('encryptionNotConfigured.body')}
            </p>
          </div>
        )}

        {view.grantedAt && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
              {t('alreadyGranted.heading')}
            </h2>
            <p className="text-sm text-red-700 dark:text-red-300 mb-3">
              On{' '}
              {formatTimestamp(
                view.grantedAt,
                userTimezone,
                dateFormat,
                timeFormat,
              )}
              , {t('alreadyGranted.description')}
            </p>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowResetConfirm(true)}
            >
              {t('alreadyGranted.clearButton')}
            </Button>
          </div>
        )}

        <form
          onSubmit={settingsForm.handleSubmit(onSettingsSubmit)}
          className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('settings.heading')}
          </h2>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <ToggleSwitch
                checked={enabledNow}
                onChange={(v) =>
                  // Clamp to off while the feature cannot be armed, so the only
                  // action a degraded install can take here is to disable it.
                  settingsForm.setValue('enabled', canArmFeature ? v : false, {
                    shouldDirty: true,
                  })
                }
                disabled={!canEditSettings}
                label={t('settings.enableLabel')}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('settings.enableLabel')}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                name="grantAfterDays"
                control={settingsForm.control}
                render={({ field }) => (
                  <NumericInput
                    label={t('settings.grantAfterDaysLabel')}
                    decimalPlaces={0}
                    max={365}
                    disabled={!canArmFeature}
                    error={settingsForm.formState.errors.grantAfterDays?.message}
                    value={field.value}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    ref={field.ref}
                  />
                )}
              />
              <Controller
                name="reminderAfterDays"
                control={settingsForm.control}
                render={({ field }) => (
                  <NumericInput
                    label={t('settings.reminderAfterDaysLabel')}
                    decimalPlaces={0}
                    max={364}
                    disabled={!canArmFeature}
                    error={settingsForm.formState.errors.reminderAfterDays?.message}
                    value={field.value}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    ref={field.ref}
                  />
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                isLoading={savingSettings}
                disabled={!canEditSettings}
              >
                {t('settings.saveButton')}
              </Button>
            </div>
          </div>
        </form>

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {tMsg('heading')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
                {tMsg('description')}
              </p>
            </div>
            {messageMode !== 'hidden' && <MessageCountdown />}
          </div>

          {messageMode === 'hidden' && (
            <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-md p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-gray-700 dark:text-gray-300">
                {messageMetadata.hasMessage ? (
                  <>
                    {tMsg('messageSet')}
                    <span className="text-gray-500 dark:text-gray-400">
                      {' '}
                      {tMsg('charCount', { count: messageMetadata.charCount })}
                      {messageMetadata.updatedAt
                        ? tMsg('updatedAt', { timestamp: formatTimestamp(messageMetadata.updatedAt, userTimezone, dateFormat, timeFormat) })
                        : ''}
                      )
                    </span>
                  </>
                ) : (
                  <span className="text-gray-500 dark:text-gray-400">
                    {tMsg('noMessage')}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleReveal}
                  disabled={
                    !view.emailConfigured ||
                    messageLoading ||
                    !messageMetadata.hasMessage
                  }
                >
                  {tMsg('revealButton')}
                </Button>
                <Button
                  size="sm"
                  onClick={handleEdit}
                  disabled={!view.emailConfigured || messageLoading}
                >
                  {messageMetadata.hasMessage
                    ? tMsg('editButton')
                    : tMsg('addButton')}
                </Button>
              </div>
            </div>
          )}

          {messageMode === 'view' && (
            <div className="space-y-3">
              <pre className="whitespace-pre-wrap break-words rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-sm font-mono text-gray-900 dark:text-gray-100">
                {messageForm.getValues('message') || tMsg('emptyMessage')}
              </pre>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={handleLockNow}>
                  {tMsg('lockNowButton')}
                </Button>
                <Button size="sm" onClick={() => setMessageMode('edit')}>
                  {tMsg('editMessageButton')}
                </Button>
              </div>
            </div>
          )}

          {messageMode === 'edit' && (
            <form
              onSubmit={messageForm.handleSubmit(onMessageSubmit)}
              className="space-y-3"
            >
              <textarea
                rows={8}
                placeholder={tMsg('messagePlaceholder')}
                className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono"
                {...messageForm.register('message')}
              />
              {messageForm.formState.errors.message && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  {messageForm.formState.errors.message.message}
                </p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {tMsg('maxCharsNote')}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleLockNow}
                  disabled={savingMessage}
                >
                  {tMsg('lockNowButton')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setMessageMode('view')}
                  disabled={savingMessage}
                >
                  {tMsg('cancelButton')}
                </Button>
                <Button type="submit" size="sm" isLoading={savingMessage}>
                  {tMsg('saveButton')}
                </Button>
              </div>
            </form>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {tContacts('heading')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
                {tContacts('description')}
              </p>
            </div>
            <Button
              size="sm"
              onClick={openCreateContact}
              disabled={!view.emailConfigured}
            >
              {tContacts('addButton')}
            </Button>
          </div>

          {view.contacts.length === 0 ? (
            <p className="text-sm text-gray-500">{tContacts('noContacts')}</p>
          ) : (
            <ul className="space-y-3">
              {view.contacts.map((c) => (
                <li
                  key={c.id}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100">
                      {c.firstName}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {c.email}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => openEditContact(c)}>
                      {tContacts('editButton')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setRemoveTarget(c)}
                    >
                      {tContacts('removeButton')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {tStatus('heading')}
          </h2>
          <dl className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
            <div>
              <dt className="inline font-medium">{tStatus('lastAccess')}</dt>
              <dd className="inline">
                {view.lastActivityAt
                  ? `${formatTimestamp(view.lastActivityAt, userTimezone, dateFormat, timeFormat)} (${tStatus('daysAgo', { count: inactiveDays ?? 0, plural: inactiveDays === 1 ? '' : 's' })})`
                  : tStatus('unknown')}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">{tStatus('lastReminderSent')}</dt>
              <dd className="inline">
                {view.lastReminderSentAt
                  ? formatTimestamp(
                      view.lastReminderSentAt,
                      userTimezone,
                      dateFormat,
                      timeFormat,
                    )
                  : tStatus('never')}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">{tStatus('grantStatus')}</dt>
              <dd className="inline">
                {view.grantedAt
                  ? tStatus('grantedOn', { timestamp: formatTimestamp(view.grantedAt, userTimezone, dateFormat, timeFormat) })
                  : tStatus('notYetGranted')}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {tStatus('timerNote')}
          </p>
        </div>

        <Modal
          isOpen={showContactForm}
          onClose={() => setShowContactForm(false)}
          maxWidth="lg"
          pushHistory
        >
          <form
            onSubmit={contactForm.handleSubmit(onContactSubmit)}
            className="flex flex-col"
          >
            <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {editingContact ? tContacts('contactModal.editTitle') : tContacts('contactModal.addTitle')}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <Input
                label={tContacts('contactModal.firstNameLabel')}
                error={contactForm.formState.errors.firstName?.message}
                {...contactForm.register('firstName')}
              />
              <Input
                label={tContacts('contactModal.emailLabel')}
                type="email"
                autoComplete="off"
                error={contactForm.formState.errors.email?.message}
                {...contactForm.register('email')}
              />
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowContactForm(false)}
                disabled={submittingContact}
              >
                {tc('cancel')}
              </Button>
              <Button type="submit" isLoading={submittingContact}>
                {editingContact ? tContacts('contactModal.saveButton') : tContacts('contactModal.addButton')}
              </Button>
            </div>
          </form>
        </Modal>

        <ConfirmDialog
          isOpen={removeTarget !== null}
          title={tContacts('removeDialog.title')}
          message={tContacts('removeDialog.message')}
          confirmLabel={removing ? tContacts('removeDialog.removingButton') : tContacts('removeDialog.removeButton')}
          variant="danger"
          pushHistory
          onConfirm={handleRemove}
          onCancel={() => setRemoveTarget(null)}
        />

        <ConfirmDialog
          isOpen={showResetConfirm}
          title={t('resetConfirm.title')}
          message={t('resetConfirm.message')}
          confirmLabel={resetting ? t('resetConfirm.clearingButton') : t('resetConfirm.clearButton')}
          variant="danger"
          pushHistory
          onConfirm={handleReset}
          onCancel={() => setShowResetConfirm(false)}
        />

        <StepUpAuthModal
          isOpen={stepUpOpen && !!selfUser}
          purpose={STEP_UP_PURPOSE}
          authProvider={selfUser?.authProvider ?? 'local'}
          hasPassword={selfUser?.hasPassword ?? false}
          reason={t('stepUp.reason')}
          oidcReturnTo="/settings/emergency-access"
          oidcResumePayload={
            pendingMode ? { mode: pendingMode } : undefined
          }
          onClose={() => {
            setStepUpOpen(false);
            setPendingMode(null);
          }}
          onVerified={() => {
            setStepUpOpen(false);
            const mode = pendingMode;
            setPendingMode(null);
            if (mode) void fetchMessageInto(mode);
          }}
        />
      </main>
    </PageLayout>
  );
}
