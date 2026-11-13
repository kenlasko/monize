import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@/test/render';
import toast from 'react-hot-toast';
import { PushPermissionError,
  defaultDeviceName,
  markRegisteredEndpointHeld,
  rememberRegisteredEndpoint,
  PushServiceError,
} from '@/lib/push';
import { notifyPushDevicesChanged } from '@/lib/pushDevicesSignal';
import { useAuthStore } from '@/store/authStore';
import { PushEnableBanner } from './PushEnableBanner';

const mockGetConfig = vi.fn();
const mockListDevices = vi.fn();
const mockFingerprint = vi.fn();
const mockGetSupport = vi.fn();
const mockEnable = vi.fn();
const mockInstalledIos = vi.fn();
const mockDismissed = vi.fn();
const mockRemember = vi.fn();

vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: {
    getConfig: () => mockGetConfig(),
    listDevices: () => mockListDevices(),
  },
  currentDeviceFingerprint: () => mockFingerprint(),
  getPushSupport: () => mockGetSupport(),
  enablePushOnThisDevice: (...args: unknown[]) => mockEnable(...args),
  isInstalledIosWebApp: () => mockInstalledIos(),
  pushPromptDismissed: (...args: unknown[]) => mockDismissed(...args),
  rememberPushPromptDismissal: (...args: unknown[]) => mockRemember(...args),
}));

const mockPathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => mockPathname(),
}));

/**
 * The file's one render. The banner fetches on mount, so a bare `render()` lets
 * the response commit after the test body -- which `src/test/act-guard.ts` fails
 * rather than logs, and rightly: an assertion against a tree React has not
 * finished updating passes or fails on timing.
 */
async function renderBanner() {
  await act(async () => {
    render(<PushEnableBanner />);
  });
}

describe('PushEnableBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      publicKey: 'PUB',
      configured: true,
      keyUnreadable: false,
    });
    mockListDevices.mockResolvedValue([]);
    mockFingerprint.mockResolvedValue('aaaabbbbccccdddd');
    mockGetSupport.mockReturnValue({ supported: true });
    mockInstalledIos.mockReturnValue(false);
    mockDismissed.mockReturnValue(false);
    mockPathname.mockReturnValue('/dashboard');
    mockEnable.mockResolvedValue({ id: 'd-1' });
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'user-1' } as never,
    });
  });

  afterEach(() => {
    // Unmount FIRST. Testing Library registers its own cleanup at import time
    // and vitest runs after-hooks in reverse registration order, so this hook
    // goes first -- and a zustand write with the tree still mounted re-renders
    // outside act(), which `src/test/act-guard.ts` fails.
    cleanup();
    useAuthStore.setState({ isAuthenticated: false, user: null });
  });

  // The whole point: the app asks, instead of waiting to be found in Settings.
  it('offers to turn notifications on', async () => {
    await renderBanner();

    expect(
      await screen.findByRole('button', { name: /turn on/i }),
    ).toBeInTheDocument();
  });

  /**
   * The rule that separates this from every news site: nothing requests the
   * permission on mount. The browser prompt appears when the reader clicks, on
   * copy that has already told them what the notifications are for.
   */
  it('requests nothing until the reader clicks', async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    await renderBanner();
    await screen.findByRole('button', { name: /turn on/i });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(mockEnable).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /turn on/i }));
    });

    // The same default name the settings panel sends, so the two enable paths
    // create the same row instead of one named and one 'Unnamed device'.
    expect(mockEnable).toHaveBeenCalledWith('PUB', defaultDeviceName());
    vi.unstubAllGlobals();
  });

  it('reports success and stops asking', async () => {
    await renderBanner();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /turn on/i }));
    });

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /turn on/i }),
      ).not.toBeInTheDocument(),
    );
  });

  // An iPhone in a Safari tab cannot be helped by any button, and this is the
  // case the product said nothing about at all.
  it('tells an iPhone in a browser tab to install the app, with no button', async () => {
    mockGetSupport.mockReturnValue({ supported: false, reason: 'ios-browser' });

    await renderBanner();

    expect(await screen.findByText(/Add to Home Screen/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /turn on/i }),
    ).not.toBeInTheDocument();
  });

  // Two refusals, two repairs. An installed iOS app is blocked in iOS Settings,
  // and sending that reader to look for browser site settings is the reported
  // experience: "there is no information anywhere about how to do it."
  it.each([
    [false, /browser's site settings/i],
    [true, /iOS Settings/i],
  ])(
    'names the repair for a blocked browser (installed iOS: %s)',
    async (installedIos, copy) => {
      mockGetSupport.mockReturnValue({ supported: false, reason: 'denied' });
      mockInstalledIos.mockReturnValue(installedIos);

      await renderBanner();

      expect(await screen.findByText(copy)).toBeInTheDocument();
    },
  );

  it('remembers a dismissal against the reader and the kind', async () => {
    await renderBanner();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    });

    expect(mockRemember).toHaveBeenCalledWith('user-1', 'enable');
    expect(
      screen.queryByRole('button', { name: /turn on/i }),
    ).not.toBeInTheDocument();
  });

  it('stays away once dismissed', async () => {
    mockDismissed.mockReturnValue(true);

    await renderBanner();

    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: /turn on/i }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['this browser is already registered', 'registered'],
    ['the instance does not offer push', 'off'],
  ])('asks nothing when %s', async (_name, situation) => {
    if (situation === 'registered') {
      mockListDevices.mockResolvedValue([
        { endpointFingerprint: 'aaaabbbbccccdddd', disabledAt: null },
      ]);
    } else {
      mockGetConfig.mockResolvedValue({
        enabled: false,
        publicKey: null,
        configured: false,
        keyUnreadable: false,
      });
    }

    await renderBanner();

    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: /turn on/i }),
    ).not.toBeInTheDocument();
  });

  // A retired row is not a registration: after a key rotation the device is
  // listed, and reading that as "already registered" would leave the user with
  // no way back other than finding Settings.
  it('still asks when the only row for this browser is retired', async () => {
    mockListDevices.mockResolvedValue([
      {
        endpointFingerprint: 'aaaabbbbccccdddd',
        disabledAt: '2026-08-01T00:00:00Z',
      },
    ]);

    await renderBanner();

    expect(
      await screen.findByRole('button', { name: /turn on/i }),
    ).toBeInTheDocument();
  });

  // A browser that kept the reader's subscription across their own sign-out is
  // about to resume on its own (`usePushResumeOnSignIn`); offering Enable over
  // it is a flash of the wrong answer.
  describe('a subscription held across the reader\'s sign-out', () => {
    it('offers nothing until the resume settles, then re-reads', async () => {
      markRegisteredEndpointHeld('user-1', 'aaaabbbbccccdddd');

      await renderBanner();
      await waitFor(() => expect(mockListDevices).toHaveBeenCalled());
      expect(
        screen.queryByRole('button', { name: /turn on/i }),
      ).not.toBeInTheDocument();

      // The resume was refused and released the subscription.
      window.localStorage.clear();
      mockFingerprint.mockResolvedValue(null);
      await act(async () => {
        notifyPushDevicesChanged();
      });

      expect(
        await screen.findByRole('button', { name: /turn on/i }),
      ).toBeInTheDocument();
    });

    it('is not waited on when the held marker names another account', async () => {
      markRegisteredEndpointHeld('user-2', 'aaaabbbbccccdddd');

      await renderBanner();

      expect(
        await screen.findByRole('button', { name: /turn on/i }),
      ).toBeInTheDocument();
    });

    it('is not waited on once the marker is no longer held', async () => {
      rememberRegisteredEndpoint('user-1', 'aaaabbbbccccdddd');

      await renderBanner();

      expect(
        await screen.findByRole('button', { name: /turn on/i }),
      ).toBeInTheDocument();
    });
  });

  it('keeps out of the way on the settings page, which already offers this', async () => {
    mockPathname.mockReturnValue('/settings');

    await renderBanner();

    await Promise.resolve();
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /turn on/i }),
    ).not.toBeInTheDocument();
  });

  it('asks nothing of a visitor who is not signed in', async () => {
    useAuthStore.setState({ isAuthenticated: false, user: null });

    await renderBanner();

    await Promise.resolve();
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  // A permission refused at the prompt changes what the banner has to say, so
  // it re-reads rather than going on offering a button the browser now ignores.
  it('switches to the repair when the prompt is refused', async () => {
    mockEnable.mockRejectedValue(new PushPermissionError('denied'));

    await renderBanner();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /turn on/i }));
    });
    mockGetSupport.mockReturnValue({ supported: false, reason: 'denied' });
    await act(async () => {});

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  // Permission granted and the push service still said no: on Brave that is
  // one privacy switch away, and the toast has to say which one.
  it('names the Brave push-service switch when the push service refuses under Brave', async () => {
    mockEnable.mockRejectedValue(new PushServiceError(true));

    await renderBanner();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /turn on/i }));
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Brave[\s\S]*Google services for push messaging/),
      ),
    );
  });

  // Installing the app is the closest the platform gets to "install with
  // notifications": there is no manifest field and no API, so the moment the
  // app is installed is the moment to ask.
  it('re-asks the question as soon as the app is installed', async () => {
    mockGetConfig.mockResolvedValue({
      enabled: false,
      publicKey: null,
      configured: false,
      keyUnreadable: false,
    });

    await renderBanner();
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(2));
  });

  // docs/frontend/shell-contract.md: inside a shell that cannot receive push the
  // banner does not nag; the settings panel carries the explanation.
  describe('inside a native shell', () => {
    afterEach(() => {
      delete window.__MONIZE_SHELL__;
    });

    it.each(['electron', 'capacitor'] as const)(
      'offers nothing and asks nothing in %s',
      async (kind) => {
        window.__MONIZE_SHELL__ = { kind, version: '1.0.0' };

        await renderBanner();

        expect(screen.queryByRole('button', { name: /turn on/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /not now/i })).toBeNull();
        expect(mockGetConfig).not.toHaveBeenCalled();
      },
    );

    it('treats a malformed flag as a browser', async () => {
      window.__MONIZE_SHELL__ = { kind: 'toaster', version: 3 };

      await renderBanner();

      expect(
        await screen.findByRole('button', { name: /turn on/i }),
      ).toBeInTheDocument();
    });
  });
});
