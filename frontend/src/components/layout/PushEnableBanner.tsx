'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import {
  currentDeviceFingerprint,
  defaultDeviceName,
  enablePushOnThisDevice,
  getPushSupport,
  isInstalledIosWebApp,
  pushApi,
  pushPromptDismissed,
  pushPromptState,
  readRegisteredEndpoint,
  rememberPushPromptDismissal,
  PushPermissionError,
  PushServiceError,
  pushPermissionMessageKey,
  type PushConfig,
  type PushPromptState,
  type PushSupport,
  samePushSupportOr,
} from '@/lib/push';
import { createLogger } from '@/lib/logger';
import { useRereadOnVisible } from '@/hooks/useRereadOnVisible';
import { subscribePushDevices } from '@/lib/pushDevicesSignal';
import { pushUnavailableShell } from '@/lib/shell';

const logger = createLogger('PushEnableBanner');

/**
 * The ask Monize was missing.
 *
 * Before this, notifications existed only for somebody who went looking:
 * Settings -> Notifications -> Enable on this device, with nothing anywhere
 * saying a permission would be needed, and nothing at all for the two people who
 * cannot get there by clicking -- an iPhone user in a Safari tab, and anybody who
 * had already refused. Reported from a real install: "to enable notifications I
 * had to delete the PWA and turn them on in the app's system settings; there is
 * no information anywhere about how to do it."
 *
 * What it deliberately is NOT is the thing every news site does. Those call
 * `Notification.requestPermission()` on page load, which browsers now punish
 * rather than honour -- Firefox shows nothing without a user gesture, Chrome
 * quiets the prompt for origins with a poor grant rate, iOS shows it only inside
 * an installed web app. Nothing here requests anything on mount: the browser
 * prompt appears when the reader clicks a button on our own copy, which has told
 * them first what the notifications are for. `push-permission-request.guard.test.ts`
 * is what keeps that true.
 *
 * There is no way to grant the permission AT install time -- no manifest field,
 * no API -- so "install with notifications" is really "ask as soon as the app is
 * installed", which is what the `appinstalled` listener below is for.
 */
export function PushEnableBanner() {
  const t = useTranslations('layout.pushBanner');
  // The permission copy lives once, in the settings namespace that owns it: this
  // banner and the settings panel report the same three outcomes, and two copies
  // of a message are two copies to keep in step across twenty locales.
  const tPermission = useTranslations('settings.notifications.push.toasts');
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const pathname = usePathname();

  const [config, setConfig] = useState<PushConfig | null>(null);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [registeredHere, setRegisteredHere] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  // Bumped by `appinstalled`, so installing the app re-asks the question
  // immediately instead of on the next navigation.
  const [installEpoch, setInstallEpoch] = useState(0);
  // Bumped when a registration changes anywhere on the page, which is how a
  // resume after sign-in (`usePushResumeOnSignIn`) reaches this banner.
  const [devicesEpoch, setDevicesEpoch] = useState(0);

  // Settings already offers all of this, in more words. Two asks on one screen
  // is one too many.
  const onSettings = pathname?.startsWith('/settings') ?? false;
  // A native shell that cannot receive push (docs/frontend/shell-contract.md)
  // has nothing for this banner to offer, and a nag that names a thing the
  // reader cannot do is worse than none. The explanation lives in the settings
  // panel, where the reader goes looking, and says why there.
  const inUnsupportedShell = pushUnavailableShell() !== null;
  const active =
    isAuthenticated && !onSettings && !dismissed && !inUnsupportedShell;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    (async () => {
      // Local reads first, and they are free. A browser that cannot do push at
      // all, or a reader who has waved every state away, costs no request.
      const currentSupport = getPushSupport();
      if (cancelled) return;
      setSupport(currentSupport);

      try {
        const pushConfig = await pushApi.getConfig();
        if (cancelled) return;
        setConfig(pushConfig);
        if (!pushConfig.enabled || !pushConfig.publicKey) return;

        // Only now, and only because the channel is on: whether THIS browser is
        // already registered is the one fact that needs the server.
        const [devices, fingerprint] = await Promise.all([
          pushApi.listDevices(),
          currentDeviceFingerprint().catch(() => null),
        ]);
        if (cancelled) return;
        // This browser kept the reader's subscription across their own
        // sign-out and the resume has not settled yet: not known, rather than
        // a flash of "Enable" over a device about to resume on its own.
        const marker = readRegisteredEndpoint();
        if (marker !== null && marker.held && marker.userId === userId) {
          setRegisteredHere(null);
          return;
        }
        setRegisteredHere(
          fingerprint !== null &&
            devices.some(
              (device) =>
                !device.disabledAt &&
                device.endpointFingerprint === fingerprint,
            ),
        );
      } catch (error) {
        // A banner is not worth an error state. Staying silent is the same as
        // this component not existing, which is where the product was.
        logger.debug('Could not decide whether to offer push', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, installEpoch, devicesEpoch, userId]);

  useEffect(
    () => subscribePushDevices(() => setDevicesEpoch((epoch) => epoch + 1)),
    [],
  );

  // Installing the app is exactly the moment to ask, and it is the closest the
  // platform gets to "install with notifications". iOS fires no such event, so
  // there the standalone launch is what `getPushSupport` reads instead.
  useEffect(() => {
    const onInstalled = () => setInstallEpoch((epoch) => epoch + 1);
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  // The permission and the display mode are both changed ELSEWHERE and then
  // returned to: site settings, iOS Settings, "Add to Home Screen". Read once,
  // this banner would go on offering a button the browser has started refusing,
  // or keep telling an installed app to install itself.
  useRereadOnVisible(
    useCallback(
      () => setSupport((previous) => samePushSupportOr(previous, getPushSupport())),
      [],
    ),
  );

  const state: PushPromptState = active
    ? pushPromptState({
        channelAvailable: !!config?.enabled && !!config.publicKey,
        support,
        // `null` is "not known yet", and offering to register a device that may
        // already be registered is how a banner becomes noise.
        registeredHere: registeredHere !== false,
        installedIosWebApp: isInstalledIosWebApp(),
      })
    : null;

  const handleDismiss = useCallback(() => {
    if (state === null) return;
    rememberPushPromptDismissal(userId, state.kind);
    setDismissed(true);
  }, [state, userId]);

  /**
   * Deliberately not an `async` function, for the reason the settings panel's
   * Enable is not: the prompt only appears while the click's transient
   * activation lasts, and iOS spends that on the first suspension. The work
   * starts synchronously; only the reporting happens after an await.
   */
  const handleEnable = () => {
    if (!config?.publicKey) return;
    const enabling = enablePushOnThisDevice(
      config.publicKey,
      defaultDeviceName(),
    );
    setIsEnabling(true);
    void (async () => {
      try {
        await enabling;
        toast.success(tPermission('enabled'));
        setDismissed(true);
      } catch (error) {
        if (error instanceof PushPermissionError) {
          // The same rule the settings panel applies, installed-iOS case
          // included: two surfaces reporting one error must not disagree.
          toast.error(tPermission(pushPermissionMessageKey(error, isInstalledIosWebApp())));
          // The browser now refuses, so the banner has a different thing to say.
          setSupport(getPushSupport());
        } else if (error instanceof PushServiceError) {
          toast.error(
            error.brave
              ? tPermission('pushServiceRefusedBrave')
              : tPermission('pushServiceRefused'),
          );
        } else {
          logger.error('Failed to enable push from the banner:', error);
          toast.error(tPermission('enableFailed'));
        }
      } finally {
        setIsEnabling(false);
      }
    })();
  };

  if (state === null) return null;
  if (pushPromptDismissed(userId, state.kind)) return null;

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
      <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-center">
        <span className="text-center sm:text-left">
          <span className="font-semibold">
            {state.kind === 'enable'
              ? t('enableTitle')
              : state.kind === 'install-ios'
                ? t('installIosTitle')
                : t('blockedTitle')}
          </span>{' '}
          {state.kind === 'enable'
            ? t('enableBody')
            : state.kind === 'install-ios'
              ? t('installIosBody')
              : state.installedIosWebApp
                ? t('blockedIosBody')
                : t('blockedBody')}
        </span>
        <span className="flex items-center justify-center gap-3 whitespace-nowrap">
          {state.kind === 'enable' && (
            <button
              type="button"
              onClick={handleEnable}
              disabled={isEnabling}
              className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 motion-reduce:transition-none dark:focus-visible:ring-offset-blue-900"
            >
              {isEnabling ? t('enabling') : t('enableButton')}
            </button>
          )}
          <button
            type="button"
            onClick={handleDismiss}
            className="text-blue-700/70 underline hover:text-blue-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:text-blue-300/70 dark:hover:text-blue-100 dark:focus-visible:ring-offset-blue-900"
          >
            {t('dismiss')}
          </button>
        </span>
      </div>
    </div>
  );
}
