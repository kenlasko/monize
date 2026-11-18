import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { AppHeader } from './AppHeader';
import { useMobileChromeStore } from '@/store/mobileChromeStore';

const mockPush = vi.fn();
const mockLogout = vi.fn().mockResolvedValue(undefined);
let mockHasTabBar = true;
let mockFirstName = 'Demo';
const mockHideOnScroll = vi.fn();

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/dashboard',
}));

vi.mock('@/lib/auth', () => ({
  authApi: { logout: (...args: unknown[]) => mockLogout(...args) },
}));

vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  holdPushForSignOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <div />,
}));

vi.mock('@/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useIsMobile')>()),
  useHasMobileTabBar: () => mockHasTabBar,
}));

vi.mock('@/hooks/useHideOnScroll', () => ({
  useHideOnScroll: (enabled: boolean) => mockHideOnScroll(enabled),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      user: { id: 'u-1', email: 'a@example.com', firstName: mockFirstName, lastName: 'B', role: 'user' },
      logout: vi.fn(),
      actingAsUserId: null,
      delegateCapabilities: null,
      delegateSections: null,
    };
    return selector ? selector(state) : state;
  },
}));

describe('AppHeader below xl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasTabBar = true;
    mockFirstName = 'Demo';
    mockHideOnScroll.mockImplementation((enabled: boolean) => ({
      ref: { current: null },
      offset: enabled ? 40 : 0,
    }));
    useMobileChromeStore.setState({ drawerOpen: false, collapsedTitle: null });
  });

  it('shows the initial as an avatar that opens Settings', () => {
    render(<AppHeader />);
    const avatar = screen.getByTestId('mobile-avatar');
    expect(avatar).toHaveTextContent('D');
    fireEvent.click(avatar);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('keeps a whole character when the name starts outside the basic range', () => {
    mockFirstName = '\u{1D49C}nn';
    render(<AppHeader />);
    expect(screen.getByTestId('mobile-avatar').textContent).toBe('\u{1D49C}');
  });

  it('swaps the avatar for the collapsed title', () => {
    render(<AppHeader />);
    act(() =>
      useMobileChromeStore.getState().setCollapsedTitle({
        title: 'Net worth',
        figure: '$10.00',
        figurePartial: true,
        change: { text: '2.6%', up: true },
      }),
    );
    const collapsed = screen.getByTestId('collapsed-header-title');
    expect(collapsed).toHaveTextContent('Net worth');
    expect(collapsed).toHaveTextContent('$10.00*');
    expect(collapsed).toHaveTextContent('2.6%');
    expect(collapsed).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByTestId('mobile-avatar')).not.toBeInTheDocument();
  });

  it('adds what the page is narrowed to, with a switcher caret outside the hidden text', () => {
    const onSelect = vi.fn();
    render(<AppHeader />);
    act(() =>
      useMobileChromeStore.getState().setCollapsedTitle({
        title: 'Transactions',
        context: 'WS Chequing',
        switcher: {
          currentId: 'a-1',
          items: [
            { id: 'a-1', primary: 'WS Chequing' },
            { id: 'a-2', primary: 'Savings', group: 'Other accounts' },
          ],
          onSelect,
          triggerLabel: 'Switch to another account',
          filterPlaceholder: 'Find an account',
          noMatchesLabel: 'No matches',
        },
      }),
    );
    const collapsed = screen.getByTestId('collapsed-header-title');
    expect(collapsed).toHaveTextContent('Transactions – WS Chequing');
    const caret = screen.getByRole('button', { name: 'Switch to another account' });
    // A control is never inside the aria-hidden copy of the title.
    expect(collapsed).not.toContainElement(caret);

    fireEvent.click(caret);
    fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
    expect(onSelect).toHaveBeenCalledWith('a-2');
  });

  it('drops the page title when the line does not fit, and brings it back when it does', () => {
    let resized: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // The invisible copy of the full line is 300px wide; the caret is 28px.
    const offset = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'collapsed-header-title-measure' ? 300 : 28;
      });
    let rowWidth = 200;
    const client = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => rowWidth);
    try {
      render(<AppHeader />);
      act(() =>
        useMobileChromeStore.getState().setCollapsedTitle({
          title: 'Investments',
          context: 'RRSP, TFSA',
          switcher: {
            currentId: '',
            items: [{ id: 'a-1', primary: 'RRSP' }],
            onSelect: vi.fn(),
            triggerLabel: 'Switch to another account',
            filterPlaceholder: 'Find an account',
            noMatchesLabel: 'No matches',
          },
        }),
      );
      const shown = () =>
        screen.getByTestId('collapsed-header-title').firstChild?.textContent;
      expect(shown()).toBe('Investments – RRSP, TFSA');

      act(() => resized?.());
      expect(shown()).toBe('RRSP, TFSA');

      rowWidth = 400;
      act(() => resized?.());
      expect(shown()).toBe('Investments – RRSP, TFSA');
    } finally {
      offset.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('leaves no caret slot when the only row is the one on screen', () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      render(<AppHeader />);
      act(() =>
        useMobileChromeStore.getState().setCollapsedTitle({
          title: 'Transactions',
          context: 'WS Chequing',
          switcher: {
            currentId: 'a-1',
            items: [{ id: 'a-1', primary: 'WS Chequing' }],
            onSelect: vi.fn(),
            triggerLabel: 'Switch to another account',
            filterPlaceholder: 'Find an account',
            noMatchesLabel: 'No matches',
          },
        }),
      );
      const row = screen.getByTestId('collapsed-header-title').parentElement;
      // The text alone: no empty wrapper whose gap and width the fit check
      // would subtract as if a caret were there.
      expect(row?.children).toHaveLength(1);
      expect(observed).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('re-measures when the caret itself resizes', () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      render(<AppHeader />);
      act(() =>
        useMobileChromeStore.getState().setCollapsedTitle({
          title: 'Transactions',
          context: 'WS Chequing',
          switcher: {
            currentId: 'a-1',
            items: [
              { id: 'a-1', primary: 'WS Chequing' },
              { id: 'a-2', primary: 'Savings' },
            ],
            onSelect: vi.fn(),
            triggerLabel: 'Switch to another account',
            filterPlaceholder: 'Find an account',
            noMatchesLabel: 'No matches',
          },
        }),
      );
      const caret = screen.getByRole('button', { name: 'Switch to another account' });
      expect(observed.some((target) => target.contains(caret))).toBe(true);
      expect(observed).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws no caret when the switcher has nowhere to go', () => {
    render(<AppHeader />);
    act(() =>
      useMobileChromeStore.getState().setCollapsedTitle({
        title: 'Transactions',
        context: 'WS Chequing',
        switcher: {
          currentId: 'a-1',
          items: [],
          onSelect: vi.fn(),
          triggerLabel: 'Switch to another account',
          filterPlaceholder: 'Find an account',
          noMatchesLabel: 'No matches',
        },
      }),
    );
    expect(screen.getByTestId('collapsed-header-title')).toHaveTextContent('Transactions – WS Chequing');
    expect(screen.queryByRole('button', { name: 'Switch to another account' })).not.toBeInTheDocument();
  });

  it('stays pinned where the tab bar is, and slides away where it is not', () => {
    const { container, unmount } = render(<AppHeader />);
    expect(mockHideOnScroll).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('header')?.style.transform).toBe('translateY(0px)');
    unmount();

    mockHasTabBar = false;
    const desktop = render(<AppHeader />);
    expect(mockHideOnScroll).toHaveBeenLastCalledWith(true);
    expect(desktop.container.querySelector('header')?.style.transform).toBe('translateY(-40px)');
  });

  it('signs out from the drawer', async () => {
    render(<AppHeader />);
    act(() => useMobileChromeStore.getState().setDrawerOpen(true));
    const drawer = screen.getByRole('navigation', { name: 'Main menu' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(useMobileChromeStore.getState().drawerOpen).toBe(false);
  });
});
