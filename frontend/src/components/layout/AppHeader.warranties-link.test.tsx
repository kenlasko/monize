import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@/test/render';
import { AppHeader } from './AppHeader';
import { useMobileChromeStore } from '@/store/mobileChromeStore';

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

vi.mock('@/lib/auth', () => ({
  authApi: { logout: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="budget-alert-badge" />,
}));

const manage = { create: true, edit: true, delete: true };
let mockActingAsUserId: string | null = null;
let mockDelegateCapabilities: unknown = null;
let mockDelegateSections: unknown = null;

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      user: { id: 'u-1', email: 'a@example.com', firstName: 'Ann', lastName: 'B', role: 'user' },
      logout: vi.fn(),
      actingAsUserId: mockActingAsUserId,
      delegateCapabilities: mockDelegateCapabilities,
      delegateSections: mockDelegateSections,
    };
    return selector ? selector(state) : state;
  },
}));

function openToolsMenu() {
  fireEvent.click(screen.getAllByText('Tools')[0]);
}

function openMobileMenu() {
  act(() => useMobileChromeStore.getState().setDrawerOpen(true));
}

describe('AppHeader Warranties entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMobileChromeStore.setState({ drawerOpen: false });
    mockActingAsUserId = null;
    mockDelegateCapabilities = null;
    mockDelegateSections = null;
  });

  it('lists Warranties in the Tools menu for the owner', () => {
    render(<AppHeader />);
    openToolsMenu();
    expect(screen.getAllByText('Warranties').length).toBeGreaterThan(0);
  });

  it('shows Warranties to a delegate granted the section, without any capability', () => {
    mockActingAsUserId = 'owner-1';
    mockDelegateSections = { warranties: true };
    render(<AppHeader />);
    openToolsMenu();
    expect(screen.getAllByText('Warranties').length).toBeGreaterThan(0);
    // A capability-gated entry stays hidden: the section grants only its own link.
    expect(screen.queryByText('Payees')).not.toBeInTheDocument();
  });

  it('shows Warranties in the mobile drawer for a delegate granted the section', () => {
    mockActingAsUserId = 'owner-1';
    mockDelegateSections = { warranties: true };
    render(<AppHeader />);
    openMobileMenu();
    expect(screen.getAllByText('Warranties').length).toBeGreaterThan(0);
  });

  it('hides Warranties from a delegate without the section, even one who manages every tool', () => {
    mockActingAsUserId = 'owner-1';
    mockDelegateCapabilities = { payees: manage, categories: manage, tags: manage };
    mockDelegateSections = { warranties: false };
    render(<AppHeader />);
    openToolsMenu();
    expect(screen.getAllByText('Tags').length).toBeGreaterThan(0);
    expect(screen.queryByText('Warranties')).not.toBeInTheDocument();
    openMobileMenu();
    expect(screen.queryByText('Warranties')).not.toBeInTheDocument();
  });
});
