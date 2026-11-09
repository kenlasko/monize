import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { MobileTabBar } from './MobileTabBar';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useMobileChromeStore } from '@/store/mobileChromeStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

const mockPush = vi.fn();
let mockPathname = '/dashboard';
let mockActingAsUserId: string | null = null;
let mockIsAuthenticated = true;
let mockDelegateSections: unknown = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      isAuthenticated: mockIsAuthenticated,
      actingAsUserId: mockActingAsUserId,
      delegateCapabilities: null,
      delegateSections: mockDelegateSections,
    }),
}));

function setTabs(mobileTabs: unknown) {
  usePreferencesStore.setState({
    preferences: { viewDefaults: { mobileTabs } } as unknown as UserPreferences,
  });
}

function bar() {
  return within(screen.getByTestId('mobile-tab-bar'));
}

describe('MobileTabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard';
    mockActingAsUserId = null;
    mockIsAuthenticated = true;
    mockDelegateSections = null;
    usePreferencesStore.setState({ preferences: null });
    useMobileChromeStore.setState({ drawerOpen: false, collapsedTitle: null });
    useCommandPaletteStore.setState({ newTransactionRequest: null });
  });

  it('defaults to Home, Transactions, Accounts and More around the add button', () => {
    render(<MobileTabBar />);
    expect(bar().getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
      'Home',
      'Transactions',
      'New transaction',
      'Accounts',
      'More',
    ]);
  });

  it('shows the tabs the reader picked, in their order', () => {
    setTabs(['budgets', 'reports', 'bills']);
    render(<MobileTabBar />);
    expect(bar().getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual([
      'Budgets',
      'Reports',
      'New transaction',
      'Bills & Deposits',
      'More',
    ]);
  });

  it('keeps More when the reader picked no tabs at all', () => {
    setTabs([]);
    render(<MobileTabBar />);
    expect(bar().getByRole('button', { name: 'More' })).toBeInTheDocument();
    expect(bar().queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('navigates to a tab and marks the current one', () => {
    mockPathname = '/accounts/abc';
    render(<MobileTabBar />);
    expect(bar().getByRole('button', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(bar().getByRole('button', { name: 'Home' }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('opens the drawer from More', () => {
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'More' }));
    expect(useMobileChromeStore.getState().drawerOpen).toBe(true);
  });

  it('lights More on a page the bar has no tab for', () => {
    mockPathname = '/budgets';
    render(<MobileTabBar />);
    expect(bar().getByRole('button', { name: 'More' }).className).toContain('text-blue-600');
  });

  it('asks for a new transaction from the add button', () => {
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'New transaction' }));
    expect(useCommandPaletteStore.getState().newTransactionRequest).toEqual({ payee: null });
    expect(mockPush).toHaveBeenCalledWith('/transactions');
  });

  it('does not push the tab for the page already open', () => {
    mockPathname = '/transactions';
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'Transactions' }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('still navigates to a section from a page below it', () => {
    mockPathname = '/accounts/abc';
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'Accounts' }));
    expect(mockPush).toHaveBeenCalledWith('/accounts');
  });

  it('drops a pending new transaction when a tab overtakes it', () => {
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'New transaction' }));
    fireEvent.click(bar().getByRole('button', { name: 'Accounts' }));
    expect(useCommandPaletteStore.getState().newTransactionRequest).toBeNull();
  });

  it('does not push when already on the register, so its filters survive', () => {
    mockPathname = '/transactions';
    render(<MobileTabBar />);
    fireEvent.click(bar().getByRole('button', { name: 'New transaction' }));
    expect(useCommandPaletteStore.getState().newTransactionRequest).toEqual({ payee: null });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('is not drawn for a signed-out visitor', () => {
    mockIsAuthenticated = false;
    render(<MobileTabBar />);
    expect(screen.queryByTestId('mobile-tab-bar')).not.toBeInTheDocument();
  });

  it('is not drawn on a public route, even with a session', () => {
    mockPathname = '/verify-email';
    render(<MobileTabBar />);
    expect(screen.queryByTestId('mobile-tab-bar')).not.toBeInTheDocument();
  });

  it('leaves a delegate only what the session can reach', () => {
    mockActingAsUserId = 'owner';
    mockDelegateSections = { accounts: true };
    render(<MobileTabBar />);
    expect(bar().queryByRole('button', { name: 'Transactions' })).not.toBeInTheDocument();
    expect(bar().queryByRole('button', { name: 'New transaction' })).not.toBeInTheDocument();
    expect(bar().getByRole('button', { name: 'Accounts' })).toBeInTheDocument();
    expect(bar().getByRole('button', { name: 'More' })).toBeInTheDocument();
  });
});
