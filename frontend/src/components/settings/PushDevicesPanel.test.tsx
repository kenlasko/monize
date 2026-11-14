import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { PushDevicesPanel } from './PushDevicesPanel';

/** Removing asks first: confirm in the dialog the row's Remove opened. */
function confirmRemove() {
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }),
  );
}
import toast from 'react-hot-toast';
import { PushPermissionError, type PushDevice } from '@/lib/push';
import { useAuthStore } from '@/store/authStore';
import { notifyPushDevicesChanged } from '@/lib/pushDevicesSignal';
import {
  SETTINGS_SECTION_DEFAULT_COLLAPSED,
  useSettingsSectionStore,
} from '@/store/settingsSectionStore';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

const mockGetConfig = vi.fn();
const mockListDevices = vi.fn();
const mockRemoveDevice = vi.fn();
const mockSendTest = vi.fn();
const mockEnable = vi.fn();
const mockDisable = vi.fn();
const mockCurrentFingerprint = vi.fn();
const mockGetPushSupport = vi.fn();
const mockIsInstalledIosWebApp = vi.fn();
const mockClassify = vi.fn();
const mockRelease = vi.fn();
const mockReadRegistered = vi.fn();
const mockRetireRow = vi.fn();

vi.mock('@/lib/push', async (importOriginal) => ({
  // The real module underneath (defaultDeviceName and friends); only the
  // network-facing and browser-facing doors are replaced.
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: {
    getConfig: () => mockGetConfig(),
    listDevices: () => mockListDevices(),

    removeDevice: (...args: any[]) => mockRemoveDevice(...args),
    sendTest: () => mockSendTest(),
  },

  enablePushOnThisDevice: (...args: any[]) => mockEnable(...args),

  disablePushOnThisDevice: (...args: any[]) => mockDisable(...args),
  currentDeviceFingerprint: () => mockCurrentFingerprint(),
  getPushSupport: () => mockGetPushSupport(),
  isInstalledIosWebApp: () => mockIsInstalledIosWebApp(),
  classifyPushRegistration: (...args: any[]) => mockClassify(...args),
  releaseLocalPushSubscription: () => mockRelease(),
  readRegisteredEndpoint: () => mockReadRegistered(),
  retireServerRowFor: (fingerprint: string) => mockRetireRow(fingerprint),
  // Declared inside the factory: `vi.mock` is hoisted above every top-level
  // binding in this file, so a class defined outside it is not yet initialised
  // when the factory runs.
  PushPermissionError: class extends Error {
    constructor(readonly reason: 'denied' | 'dismissed') {
      super('permission');
      this.name = 'PushPermissionError';
    }
  },
}));

const THIS_DEVICE = 'aaaabbbbccccdddd';
const OTHER_DEVICE = '1111222233334444';

function device(overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id: 'd-1',
    endpointFingerprint: THIS_DEVICE,
    deviceName: 'Chrome on Linux',
    userAgent: 'Mozilla/5.0',
    createdAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-02T10:00:00.000Z',
    lastSuccessAt: null,
    registeredIp: '203.0.113.7',
    disabledAt: null,
    disabledReason: null,
    ...overrides,
  };
}

describe('PushDevicesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The fold outlives a remount by design, so it outlives a test too:
    // `setup.ts` clears localStorage between tests but cannot reach the store
    // that already read it. Nothing is mounted here (RTL's cleanup ran in the
    // previous afterEach), so this write needs no act().
    useSettingsSectionStore.setState({
      collapsed: { ...SETTINGS_SECTION_DEFAULT_COLLAPSED },
    });
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);
    mockGetPushSupport.mockReturnValue({ supported: true });
    mockIsInstalledIosWebApp.mockReturnValue(false);
    // The default for every test that is not about reconciliation.
    mockClassify.mockReturnValue({ kind: 'in-sync' });
    mockRelease.mockResolvedValue(undefined);
    mockRetireRow.mockResolvedValue(undefined);
    mockReadRegistered.mockReturnValue(null);
    // Signed out by default, so a test that needs an identity states it.
    useAuthStore.setState({ user: null });
    mockEnable.mockResolvedValue(device());
    mockSendTest.mockResolvedValue({ attempted: 1, delivered: 1, devices: [] });
  });

  it('offers to enable push on this device', async () => {
    render(<PushDevicesPanel />);

    expect(
      await screen.findByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
  });

  describe('inside a native shell', () => {
    afterEach(() => {
      delete window.__MONIZE_SHELL__;
      delete window.__MONIZE_SHELL_NOTIFICATIONS__;
    });

    it('says notifications appear on this PC when the desktop app shows them natively', async () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.0.0' };
      window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish: vi.fn() };

      render(<PushDevicesPanel />);

      expect(
        await screen.findByText(/shows your notifications on this PC while it is running/i),
      ).toBeInTheDocument();
      // Still not push: nothing to enable, and no remedy that sends the reader away.
      expect(
        screen.queryByRole('button', { name: /enable on this device/i }),
      ).toBeNull();
      expect(screen.queryByText(/not available in the Monize desktop window/i)).toBeNull();
    });

    it('says the same where push is off on the server', async () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.0.0' };
      window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish: vi.fn() };
      mockGetConfig.mockResolvedValue({ enabled: false, configured: false, publicKey: null });

      render(<PushDevicesPanel />);

      expect(
        await screen.findByText(/shows your notifications on this PC while it is running/i),
      ).toBeInTheDocument();
    });

    it('says why in place of Enable in the Electron window', async () => {
      window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.0.0' };

      render(<PushDevicesPanel />);

      expect(
        await screen.findByText(/not available in the Monize desktop window/i),
      ).toHaveTextContent(/Open in browser/);
      expect(
        screen.queryByRole('button', { name: /enable on this device/i }),
      ).toBeNull();
      expect(screen.queryByText(/permission/i)).toBeNull();
    });

    it('says why in place of Enable in the Android app', async () => {
      window.__MONIZE_SHELL__ = { kind: 'capacitor', version: '' };

      render(<PushDevicesPanel />);

      expect(
        await screen.findByText(/not available in the Monize Android app yet/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /enable on this device/i }),
      ).toBeNull();
    });

    it('still offers Enable for a malformed flag', async () => {
      window.__MONIZE_SHELL__ = { kind: 'electron' };

      render(<PushDevicesPanel />);

      expect(
        await screen.findByRole('button', { name: /enable on this device/i }),
      ).toBeInTheDocument();
    });
  });

  // A test send with nothing registered would report success over nothing.
  it('disables the test button until a live device exists', async () => {
    render(<PushDevicesPanel />);

    const button = await screen.findByRole('button', {
      name: /send test notification/i,
    });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/No device is registered yet/i),
    ).toBeInTheDocument();
  });

  describe('folding the block away', () => {
    // The panel is the tallest thing in Settings -> Notifications, and most of
    // its height is only interesting while you are registering a device.
    async function collapse() {
      const summary = await screen.findByTestId('push-block-summary');
      fireEvent.click(summary);
      return summary;
    }

    /**
     * Whether the block is folded, read off the element that does the folding.
     *
     * jsdom applies no user-agent stylesheet to `<details>`, so its children
     * stay in the document whatever `open` says -- asserting the Enable button
     * has gone would pass in a browser and fail here for a reason that has
     * nothing to do with this component. `open` is the mechanism, so `open` is
     * what is asserted, alongside the summary that stands in for the content.
     */
    function isFolded() {
      const details = screen
        .getByTestId('push-block-summary')
        .closest('details');
      return details !== null && !details.open;
    }

    it('starts open, with nothing standing in for the block', async () => {
      mockListDevices.mockResolvedValue([device()]);
      render(<PushDevicesPanel />);

      expect(
        await screen.findByRole('button', { name: /send test notification/i }),
      ).toBeInTheDocument();
      expect(isFolded()).toBe(false);
      expect(
        screen.queryByTestId('push-block-collapsed-summary'),
      ).not.toBeInTheDocument();
    });

    it('hides the block and counts the devices instead', async () => {
      mockListDevices.mockResolvedValue([
        device(),
        device({ id: 'd-2', endpointFingerprint: OTHER_DEVICE }),
      ]);
      render(<PushDevicesPanel />);
      await screen.findByRole('button', { name: /send test notification/i });

      await act(async () => {
        await collapse();
      });

      expect(isFolded()).toBe(true);
      expect(
        screen.getByTestId('push-block-collapsed-summary'),
      ).toHaveTextContent('2 devices registered');
      // The heading is what is left to click on, so it stays.
      expect(screen.getByText('Browser push')).toBeInTheDocument();
    });

    it('says zero when the list really is empty', async () => {
      render(<PushDevicesPanel />);
      await screen.findByRole('button', { name: /send test notification/i });

      await act(async () => {
        await collapse();
      });

      expect(
        screen.getByTestId('push-block-collapsed-summary'),
      ).toHaveTextContent('No devices registered');
    });

    it('counts what can be delivered to, and names the rest as retired', async () => {
      // A retired row is still listed and still removable, so a bare count of
      // the rows would disagree with the list underneath -- and a count that
      // included them would claim delivery to endpoints that answer nothing.
      mockListDevices.mockResolvedValue([
        device(),
        device({
          id: 'd-2',
          endpointFingerprint: OTHER_DEVICE,
          disabledAt: '2026-08-03T10:00:00.000Z',
          disabledReason: 'KEY_ROTATED',
        }),
      ]);
      render(<PushDevicesPanel />);
      await screen.findByRole('button', { name: /send test notification/i });

      await act(async () => {
        await collapse();
      });

      expect(
        screen.getByTestId('push-block-collapsed-summary'),
      ).toHaveTextContent('1 device registered, 1 retired');
    });

    it('does not report a list that would not load as an empty one', async () => {
      // `devices` is empty because the read failed, not because the user has
      // registered nothing: "No devices registered" would send them to enable
      // push on a browser that may already be on the list.
      mockListDevices.mockRejectedValue(new Error('offline'));
      render(<PushDevicesPanel />);
      await screen.findByText(/could not load your registered devices/i);

      await act(async () => {
        await collapse();
      });

      const summary = screen.getByTestId('push-block-collapsed-summary');
      expect(summary).toHaveTextContent('Device list unavailable');
      expect(summary).not.toHaveTextContent(/No devices registered/);
    });

    it('stays folded across a remount', async () => {
      // The whole point of storing it: a fold that reopened on the next visit
      // to Settings would be a fold nobody could make stick.
      mockListDevices.mockResolvedValue([device()]);
      const { unmount } = render(<PushDevicesPanel />);
      await screen.findByRole('button', { name: /send test notification/i });
      await act(async () => {
        await collapse();
      });
      unmount();

      render(<PushDevicesPanel />);

      expect(
        await screen.findByTestId('push-block-collapsed-summary'),
      ).toHaveTextContent('1 device registered');
      expect(isFolded()).toBe(true);
    });

    it('leaves a one-sentence block unfoldable', async () => {
      // The three unavailable branches are a single sentence saying why. A
      // disclosure hiding the reason behind a click is worse than none.
      mockGetConfig.mockResolvedValue({
        enabled: false,
        publicKey: null,
        configured: true,
        keyUnreadable: false,
      });
      render(<PushDevicesPanel />);

      expect(
        await screen.findByText(/administrator has switched browser push off/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('push-block-summary'),
      ).not.toBeInTheDocument();
    });
  });

  it('marks the row that is this browser', async () => {
    mockListDevices.mockResolvedValue([
      device(),
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('Chrome on Linux');
    expect(screen.getByText('This device')).toBeInTheDocument();
    // The other device is listed, and is not claimed to be this one.
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getAllByText('This device')).toHaveLength(1);
  });

  it('badges a UnifiedPush device with its transport, and a web-push device with nothing', async () => {
    mockListDevices.mockResolvedValue([
      device(),
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'ntfy on Android',
        transport: 'unifiedpush',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('ntfy on Android');
    // Exactly one badge: the distributor device wears it, the browser row (an
    // absent transport reads as web push) does not. Queried by test id rather
    // than by its text, because every row now also NAMES its wire in the facts
    // beneath it -- a text query counts both and reads as two badges.
    expect(screen.getAllByTestId('push-transport-badge')).toHaveLength(1);
    // And the wire is spelled out per row, distributor and browser alike --
    // twice for the distributor, which wears the badge as well as the fact.
    expect(screen.getAllByText('UnifiedPush')).toHaveLength(2);
    expect(screen.getByText('Web push')).toBeInTheDocument();
  });

  it('identifies each endpoint beyond its derived device name', async () => {
    mockListDevices.mockResolvedValue([
      device({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
        createdAt: '2026-08-01T10:00:00.000Z',
        lastSeenAt: '2026-08-02T10:00:00.000Z',
        lastSuccessAt: '2026-08-02T11:00:00.000Z',
        registeredIp: '203.0.113.7',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    // `deviceName` is derived from the user agent, so two browsers on one
    // machine share it word for word. What tells the rows apart -- and what a
    // reader needs before revoking one -- is the endpoint digest, the wire, the
    // dates and the agent string.
    await screen.findByText('Endpoint');
    expect(screen.getByText(THIS_DEVICE)).toBeInTheDocument();
    expect(screen.getByText('Delivered by')).toBeInTheDocument();
    expect(screen.getByText('Registered')).toBeInTheDocument();
    expect(screen.getByText('Last active')).toBeInTheDocument();
    expect(screen.getByText('Last delivery')).toBeInTheDocument();
    expect(screen.getByText('Registered from')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(
      screen.getByText('Mozilla/5.0 (X11; Linux x86_64) Chrome/140'),
    ).toBeInTheDocument();
  });

  // Absent (a backend that predates the column) and null (a request whose
  // address the server could not determine) are the same fact -- unknown -- and
  // unknown is a state with words, never a blank cell and never an invented
  // address.
  it.each([
    // `undefined` is the shape a backend predating the column sends; `null` is
    // this backend saying it could not determine one.
    ['the field is absent', undefined],
    ['the server stored none', null],
  ])('says the address is unknown when %s', async (_name, registeredIp) => {
    mockListDevices.mockResolvedValue([device({ registeredIp })]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('Registered from');
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  // A device nothing has ever reached is exactly the one a reader is hunting
  // for, so "never" is a state with words, not a blank cell.
  // The regression: the row wrapped. The facts under the device name give the
  // content block a wide min-content, so on a `flex-wrap` row whichever device
  // had the longest endpoint digest or agent string pushed Remove onto its own
  // line -- bottom left on that one row, top right on every other, which reads
  // as a rendering fault rather than a layout.
  it('keeps Remove on the row, whatever the device name and facts are', async () => {
    mockListDevices.mockResolvedValue([
      device({
        deviceName:
          'A browser with a very long derived name on a very long platform',
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      }),
      device({ id: 'd-2', endpointFingerprint: OTHER_DEVICE, deviceName: 'B' }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('B');
    const rows = screen.getAllByRole('listitem');
    for (const row of rows) {
      expect(row.className).not.toMatch(/\bflex-wrap\b/);
    }
    // And the action itself never yields the width the content column does.
    for (const button of screen.getAllByRole('button', { name: 'Remove' })) {
      expect(button.className).toMatch(/\bflex-shrink-0\b/);
    }
  });

  // The regression: enabling push from the preference matrix wrote a row this
  // list never reloaded, so the panel below went on offering to enable a device
  // that was already registered. The two surfaces hold separate copies of the
  // list; the write announces itself to both.
  it('reloads its list when a registration changes anywhere on the page', async () => {
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);

    render(<PushDevicesPanel />);
    await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(1));

    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);
    await act(async () => {
      notifyPushDevicesChanged();
    });

    expect(await screen.findByText('Chrome on Linux')).toBeInTheDocument();
  });

  // Removing a registration is destructive, so it wears the design system's one
  // red button rather than a hand-rolled red of its own.
  it('draws Remove as the danger button', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    const remove = await screen.findByRole('button', { name: 'Remove' });
    expect(remove.className).toMatch(/\bbg-red-600\b/);
  });

  it('asks before removing a device, and removes nothing on Cancel', async () => {
    mockListDevices.mockResolvedValue([
      device({ id: 'd-2', endpointFingerprint: OTHER_DEVICE, deviceName: 'Safari on iOS' }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove Device')).toBeInTheDocument();
    expect(within(dialog).getByText(/Remove Safari on iOS\?/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(mockRemoveDevice).not.toHaveBeenCalled();
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('says so when an endpoint has never been delivered to', async () => {
    mockListDevices.mockResolvedValue([device({ lastSuccessAt: null })]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    expect(await screen.findByText('Nothing delivered yet')).toBeInTheDocument();
  });

  // The regression: a retired row is not a registration. After a rotation the
  // device is listed with the copy telling the user to enable push again, and
  // hiding the button on the strength of that row left them with the
  // instruction and no way to follow it.
  it('offers the enable button again once this browser is retired', async () => {
    mockListDevices.mockResolvedValue([
      device({
        disabledAt: '2026-08-03T10:00:00.000Z',
        disabledReason: 'KEY_ROTATED',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText(/rotated its push key pair/i);
    expect(
      screen.getByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
  });

  it('hides the enable button once this browser is registered', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

    render(<PushDevicesPanel />);

    await screen.findByText('Chrome on Linux');
    expect(
      screen.queryByRole('button', { name: /enable on this device/i }),
    ).not.toBeInTheDocument();
  });

  describe('a device held across a sign-out', () => {
    const HELD_AT = '2026-10-09T08:00:00.000Z';

    it('names the hold as its own state, not a retirement', async () => {
      mockListDevices.mockResolvedValue([
        device({
          id: 'd-2',
          endpointFingerprint: OTHER_DEVICE,
          deviceName: 'Safari on iOS',
          heldAt: HELD_AT,
        }),
      ]);

      render(<PushDevicesPanel />);

      expect(await screen.findByTestId('push-device-held')).toHaveTextContent(
        'Signed out on this device. Push resumes when you sign in here again.',
      );
      expect(screen.queryByText(/Enable push again/i)).not.toBeInTheDocument();
    });

    it('can still be removed', async () => {
      mockListDevices.mockResolvedValue([
        device({
          id: 'd-2',
          endpointFingerprint: OTHER_DEVICE,
          deviceName: 'Safari on iOS',
          heldAt: HELD_AT,
        }),
      ]);
      mockRemoveDevice.mockResolvedValue(undefined);

      render(<PushDevicesPanel />);
      await screen.findByText('Safari on iOS');

      fireEvent.click(screen.getByRole('button', { name: /remove/i }));
      confirmRemove();
      await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith('d-2'));
    });

    // The reader is signed in, so the resume hook is already re-registering it.
    it("counts this browser's held row as registered here", async () => {
      mockListDevices.mockResolvedValue([device({ heldAt: HELD_AT })]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await screen.findByTestId('push-device-held');
      expect(
        screen.queryByRole('button', { name: /enable on this device/i }),
      ).not.toBeInTheDocument();
    });

    // The server answers a test over held devices alone with "no devices".
    it('offers no test send when every live device is held', async () => {
      mockListDevices.mockResolvedValue([device({ heldAt: HELD_AT })]);

      render(<PushDevicesPanel />);

      await screen.findByTestId('push-device-held');
      expect(
        screen.getByRole('button', { name: /send test notification/i }),
      ).toBeDisabled();
      // Said, rather than left for the reader to guess.
      expect(
        screen.getByText(/Every device is signed out/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/No device is registered yet/i)).toBeNull();
    });
  });

  // The whole point of the reason column: each of the three needs a different
  // repair, and "unavailable" with no cause is a dead end.
  it.each([
    ['GONE', /No longer reachable/i],
    ['KEY_ROTATED', /rotated its push key pair/i],
    ['FAILING', /repeated delivery failures/i],
  ])(
    'says why a device disabled with %s stopped working',
    async (reason, copy) => {
      mockListDevices.mockResolvedValue([
        device({
          disabledAt: '2026-08-03T10:00:00.000Z',
          disabledReason: reason as PushDevice['disabledReason'],
        }),
      ]);

      render(<PushDevicesPanel />);

      expect(await screen.findByText(copy)).toBeInTheDocument();
    },
  );

  // Four reasons push can be unavailable, four repairs, four messages. Two
  // matter most: a key pair the server cannot read is not an administrator's
  // decision, and saying it is sends the reader to ask somebody who has nothing
  // to change; and an unreadable key has two causes whose repairs are opposites,
  // so one message told the reader to ask for a rotation the server refuses.
  it.each([
    [
      'an administrator switched it off',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: false,
      },
      /administrator has switched browser push off/i,
    ],
    [
      'the instance has no key pair',
      {
        enabled: false,
        publicKey: null,
        configured: false,
        keyUnreadable: false,
      },
      /not available on this Monize instance/i,
    ],
    [
      'the key pair cannot be read',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: true,
        encryptionAvailable: true,
      },
      /cannot read this instance's push key pair/i,
    ],
    [
      'the server has no encryption key at all',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: true,
        encryptionAvailable: false,
      },
      /missing the encryption key/i,
    ],
    // Absent, not false: during a rolling deploy an older backend sends no such
    // field, and "no information" has to read as the message this surface has
    // always shown rather than as the new one.
    [
      'an older backend does not say which cause it is',
      {
        enabled: false,
        publicKey: 'PUB',
        configured: true,
        keyUnreadable: true,
      },
      /cannot read this instance's push key pair/i,
    ],
  ])('says so in its own words when %s', async (_name, config, copy) => {
    mockGetConfig.mockResolvedValue(config);

    render(<PushDevicesPanel />);

    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  // A failed read is not "push is off here": that message sends the user to ask
  // an administrator about a switch that may well be on.
  // Two failures, two questions. A device list that will not load says nothing
  // about whether push is available here, and folding them together hid a
  // working Enable button behind "we could not check".
  it('keeps the enable button when only the device list fails', async () => {
    mockListDevices.mockRejectedValue(new Error('boom'));

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(/could not load your registered devices/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/could not check whether browser push is available/i),
    ).not.toBeInTheDocument();
  });

  it('says the status could not be read when the request fails', async () => {
    mockGetConfig.mockRejectedValue(new Error('boom'));

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(
        /could not check whether browser push is available/i,
      ),
    ).toBeInTheDocument();
    expect(mockListDevices).not.toHaveBeenCalled();
  });

  it('tells an iPhone user to install the app rather than that it cannot work', async () => {
    mockGetPushSupport.mockReturnValue({
      supported: false,
      reason: 'ios-browser',
    });

    render(<PushDevicesPanel />);

    expect(await screen.findByText(/Add to Home Screen/i)).toBeInTheDocument();
  });

  // The refusal the user reads here is a state they change SOMEWHERE ELSE and
  // then come back: site settings, or "Add to Home Screen". Read once on mount,
  // the panel kept the refusal and the hidden Enable button after the refusal
  // was lifted, and nothing on screen said a reload was needed.
  it('re-reads what the browser allows when the user returns to the page', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(/Notifications are blocked for Monize/i),
    ).toBeInTheDocument();

    mockGetPushSupport.mockReturnValue({ supported: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(
      await screen.findByRole('button', { name: /enable on this device/i }),
    ).toBeInTheDocument();
  });

  it('ignores a visibility change that leaves the page hidden', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });

    render(<PushDevicesPanel />);
    await screen.findByText(/Notifications are blocked for Monize/i);

    const readsWhileVisible = mockGetPushSupport.mock.calls.length;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();

    expect(mockGetPushSupport.mock.calls.length).toBe(readsWhileVisible);
  });

  // A browser that cannot receive push is still the browser somebody is sitting
  // at when they want to revoke a device registered on another machine.
  it('still lists and can remove devices on a browser that cannot receive push', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });
    mockListDevices.mockResolvedValue([
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockRemoveDevice.mockResolvedValue(undefined);

    render(<PushDevicesPanel />);

    expect(await screen.findByText('Safari on iOS')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /enable on this device/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    confirmRemove();
    await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith('d-2'));
  });

  it('explains a blocked permission as a browser setting to change', async () => {
    mockGetPushSupport.mockReturnValue({ supported: false, reason: 'denied' });

    render(<PushDevicesPanel />);

    expect(
      await screen.findByText(/blocked for Monize in this browser/i),
    ).toBeInTheDocument();
  });

  it('registers this device with the instance public key', async () => {
    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    await waitFor(() => expect(mockEnable).toHaveBeenCalled());
    // The key comes from the instance config, never from a literal here. The
    // device name is a suggestion and may legitimately be absent.
    expect(mockEnable.mock.calls[0][0]).toBe('PUB');
    // The list is re-read from the server rather than patched from the response.
    expect(mockListDevices).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['denied', /blocking notifications for Monize/i],
    ['dismissed', /Choose Allow when the browser asks/i],
  ])('reports a %s permission in its own words', async (reason, expected) => {
    mockEnable.mockRejectedValue(
      new PushPermissionError(reason as 'denied' | 'dismissed'),
    );

    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    // The message itself, not merely that the attempt was made: the two
    // refusals send the user to different places, and a test that stops at
    // the call cannot tell them apart.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(expected as RegExp),
      ),
    );
  });

  describe('a subscription the server has no live row for', () => {
    const withPermission = (permission: string) =>
      vi.stubGlobal('Notification', { permission });

    afterEach(() => vi.unstubAllGlobals());

    // The push service rotated it while the app was closed, so the worker's
    // message reached no window: the browser holds an endpoint the server has
    // never seen, and the list showed the dead row as active.
    it('registers a rotated subscription without asking', async () => {
      withPermission('granted');
      mockClassify.mockReturnValue({ kind: 'rotated', fingerprint: THIS_DEVICE });
      mockListDevices.mockResolvedValue([
        device({ id: 'stale', endpointFingerprint: OTHER_DEVICE }),
      ]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      // The instance key, and whatever name this agent yields -- which is
      // `undefined` for an agent `defaultDeviceName` does not recognise, so the
      // argument is read rather than matched with `expect.anything()`.
      await waitFor(() => expect(mockEnable).toHaveBeenCalled());
      expect(mockEnable.mock.calls[0][0]).toBe('PUB');
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
    });

    // The endpoint the browser replaced still has a live row, and nothing else
    // retires it: only a delivery's own 404 does, and nothing delivers to an
    // endpoint that no longer exists. Each rotation otherwise left a permanent
    // undeliverable device in the list, spending one of the account's slots.
    it('retires the row for the endpoint the rotation replaced', async () => {
      withPermission('granted');
      mockClassify.mockReturnValue({
        kind: 'rotated',
        fingerprint: THIS_DEVICE,
        supersededFingerprint: OTHER_DEVICE,
      });
      mockListDevices.mockResolvedValue([
        device({ id: 'stale', endpointFingerprint: OTHER_DEVICE }),
      ]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockRetireRow).toHaveBeenCalledWith(OTHER_DEVICE));
      // After registering the replacement, never before: a failed registration
      // must not leave the browser with no reachable device at all.
      expect(mockEnable.mock.invocationCallOrder[0]).toBeLessThan(
        mockRetireRow.mock.invocationCallOrder[0],
      );
    });

    // Another device removed this one. Removing a row cannot unsubscribe a
    // browser it is not running in, so re-registering here would undo the
    // user's revocation the next time this device opened Settings.
    it('releases a revoked subscription instead of re-registering it', async () => {
      withPermission('granted');
      mockClassify.mockReturnValue({ kind: 'revoked', fingerprint: THIS_DEVICE });
      mockListDevices.mockResolvedValue([]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockRelease).toHaveBeenCalled());
      expect(mockEnable).not.toHaveBeenCalled();
    });

    // The classifier cannot tell a foreign subscription from a revoked one
    // without both halves, so the panel has to hand it both: the marker with
    // its owner, and who is reading.
    it('asks with the marker and the reader identity', async () => {
      withPermission('granted');
      // Written before the render, so no act() wrapper is needed -- and the real
      // store rather than a mock, because a zero-argument mock of a selector
      // store returns the whole state for every selector.
      useAuthStore.setState({ user: { id: 'user-1' } as never });
      mockReadRegistered.mockReturnValue({
        userId: 'user-1',
        fingerprint: THIS_DEVICE,
      });
      mockListDevices.mockResolvedValue([]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockClassify).toHaveBeenCalled());
      expect(mockClassify.mock.calls[0][0]).toMatchObject({
        marker: { userId: 'user-1', fingerprint: THIS_DEVICE },
        readerUserId: 'user-1',
      });
    });

    // A shared browser profile: the endpoint belongs to an account that is not
    // the one reading. Releasing it revokes THEIR push on a device they still
    // hold, and they find out when a notification does not arrive.
    it.each([['in-sync'], ['no-subscription'], ['foreign']])(
      'does nothing when the state is %s',
      async (kind) => {
        withPermission('granted');
        mockClassify.mockReturnValue({ kind });
        mockListDevices.mockResolvedValue([device()]);
        mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

        render(<PushDevicesPanel />);

        await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
        expect(mockEnable).not.toHaveBeenCalled();
        expect(mockRelease).not.toHaveBeenCalled();
      },
    );

    // Re-registering is a re-registration of something consented to. Without a
    // grant it would be a permission request with no user gesture behind it,
    // which iOS answers `default` with no prompt shown -- and the user would be
    // told their permission was refused for something they never asked for.
    it('does not touch a browser that has not granted permission', async () => {
      withPermission('default');
      mockClassify.mockReturnValue({ kind: 'rotated', fingerprint: THIS_DEVICE });
      mockListDevices.mockResolvedValue([
        device({ id: 'stale', endpointFingerprint: OTHER_DEVICE }),
      ]);
      mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);

      render(<PushDevicesPanel />);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
      expect(mockEnable).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
      // And the classifier is not even consulted: no grant, nothing to reconcile.
      expect(mockClassify).not.toHaveBeenCalled();
    });
  });

  // A prompt that never appears is what an installed iOS web app does when the
  // click's user activation has been spent -- and it reaches the app as the
  // same 'dismissed' the user gets for closing a dialogue. Telling that user to
  // "choose Allow when the browser asks" sends them to wait for a dialogue that
  // is not coming.
  it('tells an installed iOS web app what to do when no prompt appeared', async () => {
    mockIsInstalledIosWebApp.mockReturnValue(true);
    mockEnable.mockRejectedValue(new PushPermissionError('dismissed'));

    render(<PushDevicesPanel />);

    fireEvent.click(
      await screen.findByRole('button', { name: /enable on this device/i }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/no prompt appeared[\s\S]*iOS Settings/i),
      ),
    );
  });

  // The prompt only appears while the click's transient activation lasts, so
  // the registration has to START inside the handler. jsdom does not model user
  // activation, so this cannot prove the browser behaviour -- what it does
  // catch is the shape that loses it: an `await` placed before the call, which
  // is how a handler acquires a suspension point without anyone noticing.
  it('starts the permission request synchronously on the click', async () => {
    render(<PushDevicesPanel />);
    const button = await screen.findByRole('button', {
      name: /enable on this device/i,
    });

    mockEnable.mockClear();
    fireEvent.click(button);

    expect(mockEnable).toHaveBeenCalledTimes(1);
    // Let the handler's async tail land inside act.
    await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
  });

  // Removing this browser's own device has to unsubscribe locally too, or the
  // browser keeps a permission the app no longer uses.
  // "Both halves, always" has to survive the first half failing: a browser
  // subscription with no server row is a permission the app holds, no longer
  // uses, and the user cannot see.
  it('still releases the browser subscription when the server delete fails', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);
    mockDisable.mockRejectedValue(new Error('server down'));

    render(<PushDevicesPanel />);
    await screen.findByText('Chrome on Linux');
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    confirmRemove();

    await waitFor(() => expect(mockDisable).toHaveBeenCalledWith('d-1'));
    // The panel reports the failure rather than pretending the device is gone.
    expect(await screen.findByText('Chrome on Linux')).toBeInTheDocument();
  });

  it('unsubscribes locally when removing this browser, not when removing another', async () => {
    mockListDevices.mockResolvedValue([
      device(),
      device({
        id: 'd-2',
        endpointFingerprint: OTHER_DEVICE,
        deviceName: 'Safari on iOS',
      }),
    ]);
    mockCurrentFingerprint.mockResolvedValue(THIS_DEVICE);
    mockDisable.mockResolvedValue(undefined);
    mockRemoveDevice.mockResolvedValue(undefined);

    render(<PushDevicesPanel />);
    await screen.findByText('Chrome on Linux');

    const [removeThis, removeOther] = screen.getAllByRole('button', {
      name: /remove/i,
    });

    fireEvent.click(removeThis);
    confirmRemove();
    await waitFor(() => expect(mockDisable).toHaveBeenCalledWith('d-1'));
    expect(mockRemoveDevice).not.toHaveBeenCalled();

    fireEvent.click(removeOther);
    confirmRemove();
    await waitFor(() => expect(mockRemoveDevice).toHaveBeenCalledWith('d-2'));
  });

  it('re-reads the device list after a test send, because a send can retire a device', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockSendTest.mockResolvedValue({
      attempted: 1,
      delivered: 0,
      devices: [{ id: 'd-1', deviceName: null, status: 'expired' }],
    });

    render(<PushDevicesPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: /send test notification/i }),
    );

    await waitFor(() => expect(mockSendTest).toHaveBeenCalled());
    expect(mockListDevices).toHaveBeenCalledTimes(2);
  });

  it('lists what each device did with the test, so "sent to 2" says which two', async () => {
    mockListDevices.mockResolvedValue([device()]);
    mockSendTest.mockResolvedValue({
      attempted: 2,
      delivered: 1,
      devices: [
        { id: 'd-1', deviceName: 'Chrome on Android', status: 'sent' },
        { id: 'd-2', deviceName: null, status: 'expired' },
      ],
    });

    render(<PushDevicesPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: /send test notification/i }),
    );

    const results = await screen.findByTestId('push-test-results');
    expect(results).toHaveTextContent('Chrome on Android');
    expect(results).toHaveTextContent(/delivered to the push service/i);
    // A nameless device is named by the same fallback the list uses, and its
    // outcome tells the reader what to do about it.
    expect(results).toHaveTextContent(/unnamed device/i);
    expect(results).toHaveTextContent(/subscription expired/i);
  });
});

describe('PushDevicesPanel and a browser-rotated subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockListDevices.mockResolvedValue([]);
    mockCurrentFingerprint.mockResolvedValue(null);
    mockGetPushSupport.mockReturnValue({ supported: true });
  });

  // The worker resubscribes and says so; this is the surface that holds the
  // session and the CSRF token, so it is the one that has to notice.
  it('re-reads the device list when the worker reports a rotation', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (type: string, fn: EventListener) =>
          listeners.set(type, fn),
        removeEventListener: () => listeners.clear(),
      },
    });
    try {
      render(<PushDevicesPanel />);
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(1));

      listeners.get('message')?.({
        data: { type: 'monize-push-subscription-changed' },
      } as unknown as Event);

      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(2));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ignores an unrelated worker message', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: (type: string, fn: EventListener) =>
          listeners.set(type, fn),
        removeEventListener: () => listeners.clear(),
      },
    });
    try {
      render(<PushDevicesPanel />);
      await waitFor(() => expect(mockListDevices).toHaveBeenCalledTimes(1));

      listeners.get('message')?.({
        data: { type: 'monize-offline-strings' },
      } as unknown as Event);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockListDevices).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
