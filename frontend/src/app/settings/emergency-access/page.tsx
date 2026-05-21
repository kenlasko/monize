'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
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
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useDemoMode } from '@/hooks/useDemoMode';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
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
    message: z
      .string()
      .max(4000, 'Message must be 4000 characters or less')
      .optional(),
  })
  .refine((data) => data.reminderAfterDays < data.grantAfterDays, {
    message: 'Reminder days must be less than grant days',
    path: ['reminderAfterDays'],
  });

type SettingsFormData = z.infer<typeof settingsSchema>;

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
              &larr; Back to Settings
            </Link>
          </div>
          <PageHeader title="Emergency Access" />
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {isDelegateView
                ? 'Emergency access can only be configured by the account owner.'
                : 'Emergency access is disabled in demo mode.'}
            </p>
          </div>
        </main>
      </PageLayout>
    );
  }

  return <EmergencyAccessSection />;
}

function EmergencyAccessSection() {
  const preferences = usePreferencesStore((s) => s.preferences);
  const userTimezone = resolveTimezone(preferences?.timezone);
  const dateFormat = preferences?.dateFormat || 'browser';
  const timeFormat: '24h' | '12h' = preferences?.timeFormat ?? '24h';

  const [view, setView] = useState<EmergencyAccessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

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
      message: '',
    },
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
        message: data.message ?? '',
      });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to load emergency access'));
      logger.error(err);
    } finally {
      setLoading(false);
    }
  }, [settingsForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSettingsSubmit = async (data: SettingsFormData) => {
    setSavingSettings(true);
    try {
      const next = await emergencyAccessApi.updateSettings({
        enabled: data.enabled,
        grantAfterDays: data.grantAfterDays,
        reminderAfterDays: data.reminderAfterDays,
        message: data.message?.trim() ? data.message.trim() : null,
      });
      setView(next);
      toast.success('Emergency access settings saved');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to save settings'));
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
      toast.success(editingContact ? 'Contact updated' : 'Contact added');
      setShowContactForm(false);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to save contact'));
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
      toast.success('Contact removed');
      setRemoveTarget(null);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to remove contact'));
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
      toast.success('Granted state cleared');
      setShowResetConfirm(false);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to reset granted state'));
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
          <PageHeader title="Emergency Access" />
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Unable to load emergency access settings.
          </p>
        </main>
      </PageLayout>
    );
  }

  const inactiveDays = daysSince(view.lastActivityAt);
  const enabledNow = settingsForm.watch('enabled');

  return (
    <PageLayout>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <div className="mb-4">
          <Link
            href="/settings"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            &larr; Back to Settings
          </Link>
        </div>

        <PageHeader
          title="Emergency Access"
          subtitle="Designate contacts who automatically receive full access to your account if you do not sign in for an extended period"
        />

        {!view.emailConfigured && (
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-200 mb-2">
              Email is not configured
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Emergency access depends on email delivery. Ask your administrator
              to configure the SMTP environment variables (SMTP_HOST, SMTP_USER,
              SMTP_PASSWORD) and try again.
            </p>
          </div>
        )}

        {view.grantedAt && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
              Emergency access already granted
            </h2>
            <p className="text-sm text-red-700 dark:text-red-300 mb-3">
              On{' '}
              {formatTimestamp(
                view.grantedAt,
                userTimezone,
                dateFormat,
                timeFormat,
              )}
              , your designated contacts received magic links to take over the
              account. If this was unintended, clear the granted state below to
              void outstanding links.
            </p>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowResetConfirm(true)}
            >
              Clear granted state
            </Button>
          </div>
        )}

        <form
          onSubmit={settingsForm.handleSubmit(onSettingsSubmit)}
          className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6"
        >
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Settings
          </h2>

          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <ToggleSwitch
                checked={enabledNow}
                onChange={(v) =>
                  settingsForm.setValue('enabled', v, { shouldDirty: true })
                }
                disabled={!view.emailConfigured}
                label="Enable emergency access"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Enable emergency access
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Days of inactivity before access is granted"
                type="number"
                min={2}
                max={365}
                disabled={!view.emailConfigured}
                error={settingsForm.formState.errors.grantAfterDays?.message}
                {...settingsForm.register('grantAfterDays', {
                  valueAsNumber: true,
                })}
              />
              <Input
                label="Days of inactivity before reminder emails"
                type="number"
                min={1}
                max={364}
                disabled={!view.emailConfigured}
                error={settingsForm.formState.errors.reminderAfterDays?.message}
                {...settingsForm.register('reminderAfterDays', {
                  valueAsNumber: true,
                })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Message to your contacts (encrypted)
              </label>
              <textarea
                rows={8}
                placeholder="Notes, instructions, locations of important documents..."
                disabled={!view.emailConfigured}
                className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono disabled:opacity-50"
                {...settingsForm.register('message')}
              />
              {settingsForm.formState.errors.message && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {settingsForm.formState.errors.message.message}
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Encrypted at rest. Plain text only. Maximum 4000 characters.
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                isLoading={savingSettings}
                disabled={!view.emailConfigured}
              >
                Save settings
              </Button>
            </div>
          </div>
        </form>

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Emergency Contacts
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
                Each contact receives a magic link by email when access is
                granted. They use it to set a new password and take over your
                account. The first contact to claim wins.
              </p>
            </div>
            <Button
              size="sm"
              onClick={openCreateContact}
              disabled={!view.emailConfigured}
            >
              Add contact
            </Button>
          </div>

          {view.contacts.length === 0 ? (
            <p className="text-sm text-gray-500">No contacts yet.</p>
          ) : (
            <ul className="space-y-3">
              {view.contacts.map((c) => (
                <li
                  key={c.id}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-white">
                      {c.firstName}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {c.email}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => openEditContact(c)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setRemoveTarget(c)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Status
          </h2>
          <dl className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
            <div>
              <dt className="inline font-medium">Last access: </dt>
              <dd className="inline">
                {view.lastActivityAt
                  ? `${formatTimestamp(view.lastActivityAt, userTimezone, dateFormat, timeFormat)} (${inactiveDays} day${inactiveDays === 1 ? '' : 's'} ago)`
                  : 'unknown'}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Last reminder sent: </dt>
              <dd className="inline">
                {view.lastReminderSentAt
                  ? formatTimestamp(
                      view.lastReminderSentAt,
                      userTimezone,
                      dateFormat,
                      timeFormat,
                    )
                  : 'never'}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Grant status: </dt>
              <dd className="inline">
                {view.grantedAt
                  ? `granted on ${formatTimestamp(view.grantedAt, userTimezone, dateFormat, timeFormat)}`
                  : 'not yet granted'}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            The timer resets automatically any time you use the app -- signing
            in, viewing a page, recording a transaction, anything authenticated.
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
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingContact ? 'Edit contact' : 'Add emergency contact'}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <Input
                label="First name"
                error={contactForm.formState.errors.firstName?.message}
                {...contactForm.register('firstName')}
              />
              <Input
                label="Email"
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
                Cancel
              </Button>
              <Button type="submit" isLoading={submittingContact}>
                {editingContact ? 'Save changes' : 'Add contact'}
              </Button>
            </div>
          </form>
        </Modal>

        <ConfirmDialog
          isOpen={removeTarget !== null}
          title="Remove contact"
          message="This contact will no longer receive emergency access. You can add them again later."
          confirmLabel={removing ? 'Removing...' : 'Remove'}
          variant="danger"
          pushHistory
          onConfirm={handleRemove}
          onCancel={() => setRemoveTarget(null)}
        />

        <ConfirmDialog
          isOpen={showResetConfirm}
          title="Clear granted state"
          message="This voids any outstanding magic links, lets the reminder cadence start again, and lets the grant cascade fire again after another period of inactivity."
          confirmLabel={resetting ? 'Clearing...' : 'Clear'}
          variant="danger"
          pushHistory
          onConfirm={handleReset}
          onCancel={() => setShowResetConfirm(false)}
        />
      </main>
    </PageLayout>
  );
}
