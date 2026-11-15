import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import { SHELL_POLL_INTERVAL_MS } from '@/lib/shell-notifications';
import { useShellNotificationBridge } from './useShellNotificationBridge';

const mockList = vi.fn();
const publish = vi.fn();

vi.mock('@/lib/notifications', () => ({
  notificationsApi: { list: () => mockList() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const ROW = {
  id: 'n-1',
  type: 'BILL_DUE',
  category: 'PAYMENTS',
  title: 'Rent: $1,250.00 due tomorrow',
  message: 'Rent of $1,250.00 is due tomorrow.',
  target: '/bills',
  isRead: false,
  createdAt: '2026-11-13T10:00:00.000Z',
};

function signIn(id: string) {
  useAuthStore.setState({
    _hasHydrated: true,
    isAuthenticated: true,
    user: { id } as never,
    actingAsUserId: null,
  });
}

async function flush() {
  await act(async () => {});
}

describe('useShellNotificationBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.clearAllMocks();
    mockList.mockResolvedValue([ROW, { ...ROW, id: 'n-2', isRead: true }]);
    window.__MONIZE_SHELL__ = { kind: 'electron', version: '1.0.0' };
    window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish };
    signIn('user-1');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete window.__MONIZE_SHELL__;
    delete window.__MONIZE_SHELL_NOTIFICATIONS__;
    useAuthStore.setState({ isAuthenticated: false, user: null, _hasHydrated: false });
  });

  it('publishes the unread rows with the generic copy on mount', async () => {
    renderHook(() => useShellNotificationBridge());
    await flush();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      identity: 'user-1',
      rows: [
        {
          id: 'n-1',
          createdAt: ROW.createdAt,
          title: 'Payment reminder',
          body: 'A bill or scheduled payment needs your attention. Open Monize for the details.',
          target: '/bills',
        },
      ],
    });
  });

  it('polls again every interval', async () => {
    renderHook(() => useShellNotificationBridge());
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHELL_POLL_INTERVAL_MS);
    });

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('backs off after a failure and publishes nothing for it', async () => {
    mockList.mockRejectedValueOnce(new Error('502'));
    renderHook(() => useShellNotificationBridge());
    await flush();
    expect(publish).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHELL_POLL_INTERVAL_MS);
    });
    expect(mockList).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHELL_POLL_INTERVAL_MS);
    });
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('tells the shell nobody is signed in, and stops polling, on sign-out', async () => {
    renderHook(() => useShellNotificationBridge());
    await flush();
    publish.mockClear();

    await act(async () => {
      useAuthStore.setState({ isAuthenticated: false, user: null });
    });
    expect(publish).toHaveBeenCalledWith({ identity: null, rows: [] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHELL_POLL_INTERVAL_MS * 3);
    });
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  // The previous person's request may answer after the switch: its rows must
  // never reach the shell under anybody's name.
  it('drops a response that arrives after the person changed', async () => {
    let answer: (rows: unknown[]) => void = () => {};
    mockList.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderHook(() => useShellNotificationBridge());
    await flush();

    mockList.mockResolvedValue([{ ...ROW, id: 'n-9' }]);
    await act(async () => {
      signIn('user-2');
    });
    await act(async () => {
      answer([ROW]);
    });

    const published = publish.mock.calls.map(([snapshot]) => snapshot);
    expect(published.every((snapshot) => snapshot.identity === 'user-2')).toBe(true);
    expect(published.flatMap((snapshot) => snapshot.rows.map((row: { id: string }) => row.id))).not.toContain('n-1');
  });

  it('says nothing while the store hydrates after a reload', async () => {
    useAuthStore.setState({ _hasHydrated: false, isAuthenticated: false, user: null });
    renderHook(() => useShellNotificationBridge());
    await flush();

    expect(publish).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('is nobody while acting for another account', async () => {
    useAuthStore.setState({ actingAsUserId: 'owner-2' });
    renderHook(() => useShellNotificationBridge());
    await flush();

    expect(publish).toHaveBeenCalledWith({ identity: null, rows: [] });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('makes no request in a browser', async () => {
    delete window.__MONIZE_SHELL__;
    delete window.__MONIZE_SHELL_NOTIFICATIONS__;
    renderHook(() => useShellNotificationBridge());
    await flush();

    expect(mockList).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
