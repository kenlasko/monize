'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import {
  currentDeviceFingerprint,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  classifyPushRegistration,
  getPushSupport,
  pushApi,
  readRegisteredEndpoint,
  releaseLocalPushSubscription,
  retireServerRowFor,
  defaultDeviceName,
  type PushConfig,
  type PushDevice,
  type PushSupport,
  type PushTestDeviceResult,
  samePushSupportOr,
} from '@/lib/push';
import { useAuthStore } from '@/store/authStore';
import { createLogger } from '@/lib/logger';
import { useDateFormat } from '@/hooks/useDateFormat';
import { pushUnavailableShell } from '@/lib/shell';
import { usePushEnable } from '@/hooks/usePushEnable';
import { useRereadOnVisible } from '@/hooks/useRereadOnVisible';
import {
  notifyPushDevicesChanged,
  subscribePushDevices,
} from '@/lib/pushDevicesSignal';
import { getErrorMessage } from '@/lib/errors';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useSettingsSectionCollapsed } from '@/store/settingsSectionStore';

const logger = createLogger('PushDevices');

/**
 * Browser push, from the account's own side: turn it on for this device, see
 * the devices this account has registered, send a test notification.
 *
 * The instance-level half -- whether this deployment offers push at all, and
 * the key pair behind it -- is an administrator's page. Nothing here reaches
 * another account's devices, and there is no route that could.
 */
export function PushDevicesPanel() {
  const t = useTranslations('settings.notifications.push');
  // Who is reading. A push subscription belongs to an account, but the browser
  // holds it per origin, so the reconciliation below has to know whether the
  // subscription it can see is this account's at all.
  const userId = useAuthStore((state) => state.user?.id ?? null);

  const [config, setConfig] = useState<PushConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<PushTestDeviceResult[] | null>(null);
  const [support, setSupport] = useState<PushSupport | null>(null);
  // Android hides notifications behind an OS toggle that no web API reveals
  // (Notification.permission, permissions.query and pushManager.permissionState
  // all read "granted" while the system drops the display), so the panel cannot
  // detect the block -- it can only tell the reader where to look. Gated on
  // Android so iOS and desktop are not told to open a menu they do not have.
  const [isAndroid, setIsAndroid] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PushDevice | null>(null);

  const refreshDevices = useCallback(async () => {
    const [rows, fingerprint] = await Promise.all([
      pushApi.listDevices(),
      currentDeviceFingerprint().catch(() => null),
    ]);
    setDevices(rows);
    setThisDevice(fingerprint);
    setDevicesFailed(false);
  }, []);

  // Registering this browser's endpoint. Shared with the action offered from
  // the preference matrix, so the transient-activation rule and the three
  // refusal messages are written once (`usePushEnable`).
  const { isEnabling, enable: handleEnable } = usePushEnable(config?.publicKey);

  // Timestamps are instants, so they are rendered in the timezone and time
  // format the reader chose in Preferences -- not the browser's, which is what
  // a bare `toLocaleString()` reaches for.
  const { formatDateTime } = useDateFormat();

  // A registration made anywhere on this page is a registration this list has
  // to show. The matrix's own "Enable on this device" writes the same rows.
  useEffect(
    () =>
      subscribePushDevices(() => {
        void refreshDevices().catch(() => setDevicesFailed(true));
      }),
    [refreshDevices],
  );

  /**
   * Re-read what this browser supports whenever the user comes back to the page.
   *
   * `getPushSupport` reads `Notification.permission` and, on iOS, whether this
   * window is the installed app -- both of which the user changes ELSEWHERE and
   * then returns: site settings, or "Add to Home Screen". Read once on mount,
   * the panel went on saying the browser had refused after the refusal was
   * lifted, with the Enable button still hidden and no way to get it back short
   * of a reload nobody was told to do.
   *
   * Only on becoming visible, and only when the answer actually differs, so a
   * tab switch is not a re-render.
   */
  useRereadOnVisible(
    useCallback(
      () => setSupport((previous) => samePushSupportOr(previous, getPushSupport())),
      [],
    ),
  );

  // A browser can rotate its subscription on its own; the worker resubscribes
  // and says so, and this is the surface that holds the session and the CSRF
  // token needed to register the replacement. Without it the row keeps naming a
  // dead endpoint and delivery stops with nothing to show for it.
  //
  // This only covers a rotation that happens while this page is open, which is
  // the less likely case: a rotation while the app is closed posts to
  // `clients.matchAll()` and finds nobody. The durable half is the
  // reconciliation below, which reads the browser's own record rather than a
  // message that may never have been delivered. It is still Settings-gated --
  // app-wide recovery is named in the notification-permission work, not
  // pretended here.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    // The container is captured, not re-read at teardown: an effect's cleanup
    // must not depend on a global still being what it was when it subscribed.
    const worker = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'monize-push-subscription-changed') return;
      void refreshDevices().catch(() => setDevicesFailed(true));
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, [refreshDevices]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pushConfig = await pushApi.getConfig();
        if (cancelled) return;
        setConfig(pushConfig);
        setSupport(getPushSupport());
        setIsAndroid(
          typeof navigator !== 'undefined' &&
            /Android/i.test(navigator.userAgent),
        );
      } catch (error) {
        if (cancelled) return;
        // A failed read is not "push is off here". Rendering the panel as
        // disabled would tell the user to ask an administrator about a switch
        // that may be on.
        logger.error('Failed to load push configuration:', error);
        setConfigFailed(true);
        return;
      } finally {
        if (!cancelled) setIsLoading(false);
      }

      // Its own try, and its own failure: a device list that will not load says
      // nothing about whether push is available here, and folding the two
      // together hid a working Enable button behind "we could not check".
      try {
        await refreshDevices();
      } catch (error) {
        if (cancelled) return;
        logger.error('Failed to load push devices:', error);
        setDevicesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDevices]);

  /**
   * Reconcile the subscription this browser holds with the server's rows.
   *
   * Two states need acting on, and they are the two ways "the server has no live
   * row for the endpoint I hold" happens (`classifyPushRegistration`):
   *
   *   * `rotated` -- the push service replaced the subscription while the app was
   *     closed, so the worker's `pushsubscriptionchange` message reached no
   *     window. The browser holds an endpoint the server has never seen and the
   *     server holds a row naming a dead one, which the device list showed as
   *     ACTIVE: the interface asserted delivery was working while nothing could
   *     be delivered. Register the new endpoint.
   *   * `revoked` -- another device removed this one. Removing a row cannot
   *     unsubscribe a browser it is not running in, so this browser still holds
   *     the subscription; registering it again would UNDO the revocation the
   *     next time this device opened Settings. Release it locally instead, which
   *     is what the codebase already says about a subscription with no row: a
   *     permission the app holds, no longer uses, and the user cannot see.
   *
   * Only ever with permission already `granted`. Without a grant this would be a
   * permission request with no user gesture behind it, which iOS answers
   * `default` with no prompt shown -- and the user would be told their
   * permission was refused for something they never asked for.
   *
   * Once per mount, so a server that keeps refusing cannot become a loop.
   */
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    if (!config?.enabled || !config.publicKey) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const state = classifyPushRegistration({
      currentFingerprint: thisDevice,
      liveFingerprints: devices
        .filter((device) => !device.disabledAt)
        .map((device) => device.endpointFingerprint),
      marker: readRegisteredEndpoint(),
      readerUserId: userId,
    });
    if (
      state.kind === 'in-sync' ||
      state.kind === 'no-subscription' ||
      // Somebody else's subscription in a shared browser. Not ours to repair.
      state.kind === 'foreign'
    ) {
      return;
    }
    reconciled.current = true;
    const publicKey = config.publicKey;
    (async () => {
      try {
        if (state.kind === 'rotated') {
          await enablePushOnThisDevice(publicKey, defaultDeviceName());
          // The endpoint the browser replaced still has a live row, and nothing
          // else would ever retire it: only a delivery's own 404 does, and
          // nothing delivers to an endpoint that no longer exists. Left behind,
          // each rotation added a permanent undeliverable "device" to the user's
          // list and spent one of their MAX_LIVE_DEVICES_PER_USER slots.
          await retireServerRowFor(state.supersededFingerprint);
          await refreshDevices();
          return;
        }
        await releaseLocalPushSubscription();
        setThisDevice(null);
      } catch (error) {
        // Best effort and silent: the user did not ask for this, and the Enable
        // button is still there for them if it fails.
        logger.error('Failed to reconcile this push subscription:', error);
      }
    })();
  }, [config, thisDevice, devices, refreshDevices, userId]);

  // A retired row is not a registration: after a key rotation the device is
  // listed with the copy telling the user to enable push again, and hiding the
  // button on the strength of that row left them with the instruction and no
  // way to follow it.
  //
  // A HELD row of this browser is one: the reader is signed in, so
  // `usePushResumeOnSignIn` is already resuming it, and an Enable offered here
  // would duplicate that work.
  const registeredHere = devices.find(
    (device) =>
      thisDevice !== null &&
      device.endpointFingerprint === thisDevice &&
      !device.disabledAt,
  );
  const liveDevices = devices.filter((device) => !device.disabledAt);
  // What a test send can reach: a held device is live but receives nothing
  // until its account signs in there again, and the server answers a test over
  // held devices alone with "no devices".
  const deliverableDevices = liveDevices.filter((device) => !device.heldAt);

  const handleRemove = async (device: PushDevice) => {
    setPendingRemove(null);
    setRemovingId(device.id);
    try {
      const isThisBrowser = device.endpointFingerprint === thisDevice;
      if (isThisBrowser) {
        // Both halves: the server row AND the browser subscription. Leaving
        // either behind is a device the user can neither receive on nor see.
        await disablePushOnThisDevice(device.id);
      } else {
        await pushApi.removeDevice(device.id);
      }
      await refreshDevices();
      // The matrix gates its push columns on there being a live device, so the
      // last removal has to reach it: left stale, it kept offering toggles for
      // a channel that could no longer deliver.
      notifyPushDevicesChanged();
      toast.success(t('toasts.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.removeFailed')));
    } finally {
      setRemovingId(null);
    }
  };

  const handleSendTest = async () => {
    setIsSendingTest(true);
    try {
      const result = await pushApi.sendTest();
      // Every live device is attempted; the list below says what each one did,
      // because "sent to 2 devices" cannot tell the reader WHICH two.
      setLastTest(result.devices);
      await refreshDevices();
      if (result.delivered === result.attempted) {
        toast.success(t('toasts.testSent', { count: result.delivered }));
      } else if (result.delivered > 0) {
        toast.success(
          t('toasts.testPartial', {
            delivered: result.delivered,
            attempted: result.attempted,
          }),
        );
      } else {
        toast.error(t('toasts.testFailed'));
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.testFailed')));
    } finally {
      setIsSendingTest(false);
    }
  };

  if (isLoading) return null;

  if (configFailed) {
    return (
      <PushBlock heading={t('heading')}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('statusUnavailable')}
        </p>
      </PushBlock>
    );
  }

  if (!config?.enabled) {
    // Three reasons, three messages. A key pair the server cannot read is not
    // an administrator's decision, and saying it is sends the reader to ask
    // somebody who has nothing to change.
    // Four, once the unreadable key is asked WHY. Rotating repairs a key that
    // changed under a live database and is refused outright when the server has
    // no encryption key at all, so one of the two messages named a repair that
    // could not work. `encryptionAvailable === false` is the deliberate read:
    // absent means an older backend, which is the rotate case.
    const reason = !config?.configured
      ? 'notConfigured'
      : config.keyUnreadable
        ? config.encryptionAvailable === false
          ? 'serverKeyMissing'
          : 'keyUnreadable'
        : 'disabledByAdmin';
    return (
      <PushBlock heading={t('heading')}>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t(reason)}</p>
      </PushBlock>
    );
  }

  // A browser that cannot receive push still has to be able to SEE and REMOVE
  // the devices this account registered elsewhere -- suppressing the list left a
  // user with no way to revoke a device from the machine they were sitting at.
  // A native shell that cannot receive push is told so in its own words: the
  // webview's `getPushSupport` can say "supported" for a window with no push
  // service behind it, so the shell is asked first. Keyed by kind only to pick
  // the sentence (it names the shell's own remedy); the decision is a capability.
  const unavailableShell = pushUnavailableShell();
  const unsupportedReason = unavailableShell
    ? `shell.${unavailableShell.kind}`
    : support && !support.supported
      ? (support.reason ?? 'unsupported')
      : undefined;

  // What the block says about itself while it is folded away. A failed device
  // read is its own answer, never a count: `devices` is empty (or stale) then,
  // and "No devices registered" over a list that would not load tells the user
  // to enable push on a browser that may already be registered.
  const retiredCount = devices.length - liveDevices.length;
  const collapsedSummary = devicesFailed
    ? t('collapsedDevicesUnavailable')
    : retiredCount > 0
      ? t('collapsedDevicesWithRetired', {
          count: liveDevices.length,
          retired: retiredCount,
        })
      : t('collapsedDevices', { count: liveDevices.length });

  return (
    <PushBlock heading={t('heading')} collapsedSummary={collapsedSummary}>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        {unsupportedReason
          ? t(`unsupported.${unsupportedReason}`)
          : t('description')}
      </p>

      {isAndroid && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          {t('androidNotify')}
        </p>
      )}

      {devicesFailed && (
        <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
          {t('devicesUnavailable')}
        </p>
      )}

      {devices.length > 0 && (
        <ul className={`mb-4 ${TABLE_BODY_CLASS}`}>
          {devices.map((device) => (
            <li
              key={device.id}
              // Deliberately NOT `flex-wrap`. The facts below the device name
              // give the content block a wide min-content -- an endpoint digest,
              // an agent string -- so on a wrapping row whichever device had the
              // longest of them pushed Remove onto its own line, bottom left,
              // while every other row kept it top right. The content column
              // shrinks (`min-w-0`, with `truncate`/`break-all` inside it) and
              // the action never does, which is how the token and trusted-device
              // lists in this same page are laid out.
              className="flex items-start justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {device.deviceName || t('unnamedDevice')}
                  {device.endpointFingerprint === thisDevice && (
                    <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                      {t('thisDevice')}
                    </span>
                  )}
                  {device.transport === 'unifiedpush' && (
                    <span
                      data-testid="push-transport-badge"
                      className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                    >
                      {t('unifiedpushBadge')}
                    </span>
                  )}
                </p>
                {device.disabledAt ? (
                  <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                    {t(`disabledReason.${device.disabledReason ?? 'GONE'}`)}
                  </p>
                ) : (
                  device.heldAt && (
                    // Its own state, neither active nor retired: the endpoint
                    // is healthy and the user has nothing to repair.
                    <p
                      className="mt-0.5 text-xs text-gray-600 dark:text-gray-300"
                      data-testid="push-device-held"
                    >
                      {t('held')}
                    </p>
                  )
                )}
                {/* What tells one registration from another. `deviceName` is
                    derived from the user agent, so several browsers on one
                    machine share it word for word -- and a device the reader is
                    deciding whether to REVOKE has to be identifiable before they
                    can. The endpoint digest is the row's own identity (the
                    endpoint itself is a delivery credential and never leaves the
                    server), the wire says how it is reached, and the three dates
                    say when it was added, last heard from, and last actually
                    delivered to. */}
                <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                  <DeviceFact label={t('facts.endpoint')}>
                    <span className="font-mono break-all">
                      {device.endpointFingerprint}
                    </span>
                  </DeviceFact>
                  <DeviceFact label={t('facts.transport')}>
                    {t(`transport.${device.transport ?? 'webpush'}`)}
                  </DeviceFact>
                  <DeviceFact label={t('facts.registeredIp')}>
                    {/* Absent (an older backend) and null (the server could not
                        determine one) are both unknown, and unknown is a state
                        with words -- never a blank cell, and never an address
                        nobody was at. */}
                    {device.registeredIp ?? t('facts.unknownIp')}
                  </DeviceFact>
                  <DeviceFact label={t('facts.registered')}>
                    {formatDateTime(device.createdAt)}
                  </DeviceFact>
                  <DeviceFact label={t('facts.lastSeen')}>
                    {formatDateTime(device.lastSeenAt)}
                  </DeviceFact>
                  <DeviceFact label={t('facts.lastDelivery')}>
                    {/* Never delivered is a state, not a blank: a device that
                        has never received anything is exactly the one a reader
                        is trying to find. */}
                    {device.lastSuccessAt
                      ? formatDateTime(device.lastSuccessAt)
                      : t('facts.noDelivery')}
                  </DeviceFact>
                  {device.userAgent && (
                    <DeviceFact label={t('facts.userAgent')}>
                      <span
                        className="block truncate font-mono"
                        title={device.userAgent}
                      >
                        {device.userAgent}
                      </span>
                    </DeviceFact>
                  )}
                </dl>
              </div>
              <Button
                variant="danger"
                size="sm"
                disabled={removingId === device.id}
                onClick={() => setPendingRemove(device)}
                className="flex-shrink-0"
              >
                {t('removeButton')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Said BEFORE the click, not after it fails. The reported experience was
          clicking Enable and being told permission had not been granted, by an
          app that had never mentioned a permission was involved. */}
      {!registeredHere && !unsupportedReason && (
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          {t('permissionHint')}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!registeredHere && !unsupportedReason && (
          <Button
            variant="outline"
            size="sm"
            disabled={isEnabling}
            onClick={handleEnable}
          >
            {isEnabling ? t('enablingButton') : t('enableButton')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={isSendingTest || deliverableDevices.length === 0}
          onClick={handleSendTest}
        >
          {isSendingTest ? t('sendingTestButton') : t('sendTestButton')}
        </Button>
      </div>

      {liveDevices.length === 0 && !unsupportedReason && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('noLiveDevices')}
        </p>
      )}
      {/* Every live device is held: the test button is off for a reason the
          reader would otherwise have to guess. */}
      {liveDevices.length > 0 && deliverableDevices.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('noDeliverableDevices')}
        </p>
      )}

      {lastTest && lastTest.length > 0 && (
        <div className="mt-3" data-testid="push-test-results">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('testResults.heading')}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
            {lastTest.map((device) => (
              <li key={device.id}>
                {device.deviceName ?? t('unnamedDevice')}
                {': '}
                {t(`testResults.status.${device.status}`)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingRemove !== null}
        title={t('removeDialog.title')}
        message={t('removeDialog.message', {
          device: pendingRemove?.deviceName || t('unnamedDevice'),
        })}
        confirmLabel={t('removeButton')}
        variant="danger"
        onConfirm={() => {
          if (pendingRemove) void handleRemove(pendingRemove);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </PushBlock>
  );
}

/** One labelled fact about a registered endpoint, as a `<dl>` row pair. */
function DeviceFact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-gray-400 dark:text-gray-500">{label}</dt>
      <dd className="min-w-0 text-gray-600 dark:text-gray-300">{children}</dd>
    </>
  );
}

/**
 * The bordered block every branch of this panel renders into.
 *
 * `collapsedSummary` makes it foldable, and only the configured branch passes
 * one: the other three are a single sentence saying why push is unavailable,
 * and a disclosure that hides the reason behind a click is worse than no
 * disclosure. The `<details>`/`<summary>` pair is the same shape
 * `PushDiagnostics` uses twenty lines below -- native keyboard operation, and
 * the expanded/collapsed state announced without an `aria-expanded` of our own.
 *
 * `open` is a controlled prop rather than a one-shot attribute, and the summary
 * click is handled here rather than left to the element. React does not manage
 * `open` for us, so setting it once and letting the element toggle itself
 * leaves the state this component renders from disagreeing with the DOM the
 * moment the user folds the block -- and the count is rendered off exactly that
 * state. `onToggle` alone is not enough to close that gap either: it is the
 * only signal a native toggle gives, and jsdom flips `open` without ever firing
 * it, so the behaviour would be untestable here and a missed event in any
 * browser would leave the count describing the wrong state. It stays wired
 * anyway for the toggles no click produces -- Chrome expands a `<details>` to
 * show a find-in-page match.
 *
 * The fold is remembered per browser (`settingsSectionStore`), not per account:
 * whether this panel is worth its height is a fact about the screen in front of
 * the reader, the same reasoning row density and the register's date view are
 * stored on. It defaults to open, so a reader who has never folded it sees
 * exactly what they saw before -- and a stored value that is not a boolean
 * falls back to that default rather than hiding push behind a corrupted entry.
 */
function PushBlock({
  heading,
  collapsedSummary,
  children,
}: {
  heading: string;
  /**
   * Rendered beside the heading while the block is folded, and omitted while it
   * is open -- the expanded block already lists the devices this counts, so
   * showing it in both states says the same thing twice. Absent means the block
   * does not fold at all.
   */
  collapsedSummary?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { collapsed, setCollapsed } = useSettingsSectionCollapsed('push');
  const open = !collapsed;

  return (
    // The tour anchor lives here rather than on any one of the four branches
    // above, so a step pointing at "browser push" still lands on a deployment
    // where an administrator has not enabled it -- the block that says so is
    // exactly what such a reader needs to see.
    <div
      {...tourAnchor(TOUR_ANCHORS.notificationPushDevices)}
      className="border-t border-gray-200 pt-4 dark:border-gray-700"
    >
      {collapsedSummary === undefined ? (
        <>
          <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {heading}
          </h3>
          <div className="mt-2">{children}</div>
        </>
      ) : (
        <details
          open={open}
          onToggle={(event) => setCollapsed(!event.currentTarget.open)}
        >
          <summary
            className="cursor-pointer"
            data-testid="push-block-summary"
            onClick={(event) => {
              // Cancels the element's own activation behaviour, so `open` moves
              // only through this state. Enter and Space on a focused summary
              // dispatch a click too, so the keyboard path comes with it.
              event.preventDefault();
              setCollapsed(open);
            }}
          >
            {/* `inline` keeps the heading on the disclosure marker's own line;
                the h3 stays so the block holds its place in the page's heading
                outline whichever branch rendered it. */}
            <h3 className="inline text-sm font-semibold text-gray-900 dark:text-gray-100">
              {heading}
            </h3>
            {!open && (
              <span
                className="ml-2 text-sm text-gray-500 dark:text-gray-400"
                data-testid="push-block-collapsed-summary"
              >
                {collapsedSummary}
              </span>
            )}
          </summary>
          <div className="mt-3">{children}</div>
        </details>
      )}
    </div>
  );
}
