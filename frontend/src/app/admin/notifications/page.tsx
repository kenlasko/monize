'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Card } from '@/components/ui/Card';
import {
  PushChannelsPanel,
  VapidIdentityPanel,
  type ChannelRow,
} from '@/components/admin/PushChannelsPanel';
import { useAuthStore } from '@/store/authStore';
import {
  adminNotificationsApi,
  type AdminPushConfig,
} from '@/lib/admin-notifications';
import { userSettingsApi } from '@/lib/user-settings';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('AdminNotifications');

export default function AdminNotificationsPage() {
  return (
    <ProtectedRoute>
      <AdminNotificationsContent />
    </ProtectedRoute>
  );
}

/**
 * Instance-level notification settings: which channels this deployment offers,
 * and the Web Push identity behind one of them.
 *
 * Nothing here is per user. An administrator decides whether the deployment can
 * push at all; every account manages its own devices, test notification and
 * preferences in its own settings, and this page has no route to another user's
 * notifications (discussion #1291).
 */
function AdminNotificationsContent() {
  const t = useTranslations('admin.notificationsPage');
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.user);

  const [config, setConfig] = useState<AdminPushConfig | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isTogglingPush, setIsTogglingPush] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  // Gated on the role rather than fired unconditionally: an administrator-only
  // endpoint answers a non-admin with a 403, and the only thing that reaches the
  // screen is an error toast on a page they are already being redirected away
  // from. `undefined` while the store hydrates is neither -- it just waits.
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      router.push('/dashboard');
    }
  }, [currentUser, router]);

  const loadConfig = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const data = await adminNotificationsApi.getChannels();
        setConfig(data);
        setLoadFailed(false);
      } catch (error) {
        logger.error('Failed to load notification channels:', error);
        // A failed read is not an instance with push switched off. Rendering the
        // panel from a null config would show an operator a state the server
        // never reported.
        setLoadFailed(true);
        toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  useEffect(() => {
    if (!isAdmin) return;
    loadConfig();
  }, [isAdmin, loadConfig]);

  useEffect(() => {
    if (!isAdmin) return;
    userSettingsApi
      .getSmtpStatus()
      .then((status) => setSmtpConfigured(status.configured))
      // null keeps "we do not know" distinct from "not configured": the email
      // row then says the status is unavailable rather than claiming SMTP is off.
      .catch(() => setSmtpConfigured(null));
  }, [isAdmin]);

  const handleTogglePush = async () => {
    if (!config) return;
    const next = !config.enabled;
    setIsTogglingPush(true);
    try {
      const updated = await adminNotificationsApi.setWebPushEnabled(next);
      setConfig(updated);
      toast.success(next ? t('toasts.pushEnabled') : t('toasts.pushDisabled'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.pushToggleFailed')));
    } finally {
      setIsTogglingPush(false);
    }
  };

  const handleRotate = async () => {
    setConfirmRotate(false);
    setIsRotating(true);
    try {
      const result = await adminNotificationsApi.rotateVapidKeys();
      setConfig(result.config);
      toast.success(
        t('toasts.rotated', { count: result.disabledSubscriptions }),
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.rotateFailed')));
    } finally {
      setIsRotating(false);
    }
  };

  if (!isAdmin) {
    return null;
  }

  const channels: ChannelRow[] = config
    ? [
        {
          id: 'in-app',
          name: t('channels.inApp.name'),
          description: t('channels.inApp.description'),
          state: 'on',
        },
        {
          id: 'web-push',
          name: t('channels.webPush.name'),
          description: t('channels.webPush.description'),
          state:
            config.configured && !config.keyUnreadable
              ? config.enabled
                ? 'on'
                : 'off'
              : 'unconfigured',
          // Four states, four repairs: no key pair at all, a key pair this
          // server cannot decrypt, the same with no ENCRYPTION_KEY to decrypt it
          // WITH, and a channel an administrator turned off. Folding any of them
          // into another sends an operator to fix something that is not broken --
          // and the third folded into the second named a repair (rotate) that
          // `rotateKeyPair` refuses in exactly that state.
          unavailableNote: !config.configured
            ? t('channels.webPush.missingKeys')
            : config.keyUnreadable
              ? config.encryptionAvailable === false
                ? t('channels.webPush.serverKeyMissing')
                : t('channels.webPush.keyUnreadable')
              : undefined,
          toggle: {
            label: t('channels.webPush.toggleLabel'),
            checked: config.enabled,
            onChange: handleTogglePush,
            disabled:
              isTogglingPush || !config.configured || config.keyUnreadable,
          },
        },
        {
          id: 'email',
          name: t('channels.email.name'),
          description: t('channels.email.description'),
          // Three states, not two. `null` is "we could not read the status",
          // and drawing it as "Unavailable" contradicted the note beside it and
          // sent an operator to configure SMTP that may already be configured.
          state:
            smtpConfigured === null
              ? 'unknown'
              : smtpConfigured
                ? 'on'
                : 'unconfigured',
          unavailableNote:
            smtpConfigured === null
              ? t('channels.email.statusUnavailable')
              : smtpConfigured
                ? undefined
                : t('channels.email.missingSmtp'),
        },
        {
          id: 'ntfy',
          name: t('channels.ntfy.name'),
          description: t('channels.ntfy.description'),
          // The same encrypted Web Push wire and the same key pair as browser
          // push (spec section 15), so its state IS the browser-push state: an
          // instance that cannot sign, or whose administrator switched push off,
          // cannot deliver to a distributor either. Drawing it independently
          // would tell an operator a channel is open that the switch above shut.
          state:
            config.configured && !config.keyUnreadable
              ? config.enabled
                ? 'on'
                : 'off'
              : 'unconfigured',
          unavailableNote:
            config.configured && !config.keyUnreadable && config.enabled
              ? undefined
              : t('channels.ntfy.followsWebPush'),
        },
      ]
    : [];

  return (
    <PageLayout>
      <main className="px-4 pt-6 pb-8 sm:px-6 lg:px-12">
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          helpUrl={docsUrl('adminNotifications')}
        />

        {isLoading ? (
          <LoadingSpinner text={t('loading')} />
        ) : loadFailed || !config ? (
          <Card padding="md">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t('loadUnavailable')}
            </p>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card as="section" className="overflow-hidden" aria-labelledby="admin-push-channels-heading">
              <h2
                id="admin-push-channels-heading"
                className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900 sm:px-6 dark:border-gray-700 dark:text-gray-100"
              >
                {t('channelsHeading')}
              </h2>
              <PushChannelsPanel channels={channels} />
            </Card>

            <Card as="section" className="overflow-hidden" aria-labelledby="admin-push-identity-heading">
              <h2
                id="admin-push-identity-heading"
                className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900 sm:px-6 dark:border-gray-700 dark:text-gray-100"
              >
                {t('identityHeading')}
              </h2>
              <VapidIdentityPanel
                config={config}
                isRotating={isRotating}
                onRotate={() => setConfirmRotate(true)}
              />
            </Card>

            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('perAccountNote')}
            </p>
          </div>
        )}
      </main>

      <ConfirmDialog
        isOpen={confirmRotate}
        variant="warning"
        title={t('dialogs.rotateTitle')}
        message={t('dialogs.rotateMessage', {
          count: config?.liveSubscriptionCount ?? 0,
        })}
        confirmLabel={t('dialogs.rotateConfirm')}
        onConfirm={handleRotate}
        onCancel={() => setConfirmRotate(false)}
      />
    </PageLayout>
  );
}
