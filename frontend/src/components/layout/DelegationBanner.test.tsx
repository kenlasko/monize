import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { DelegationBanner } from './DelegationBanner';

vi.mock('@/lib/delegation', () => ({
  delegationApi: {
    getContexts: vi.fn(),
    switchContext: vi.fn(),
  },
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { delegationApi } from '@/lib/delegation';

const state: {
  isAuthenticated: boolean;
  actingAsUserId: string | null;
  availableContexts: any[];
  setDelegation: (a: string | null, c: any[]) => void;
} = {
  isAuthenticated: true,
  actingAsUserId: null,
  availableContexts: [],
  setDelegation: vi.fn((a, c) => {
    state.actingAsUserId = a;
    state.availableContexts = c;
  }),
};

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) => selector(state),
}));

const assignMock = vi.fn();

describe('DelegationBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.isAuthenticated = true;
    state.actingAsUserId = null;
    state.availableContexts = [];
    state.setDelegation = vi.fn((a, c) => {
      state.actingAsUserId = a;
      state.availableContexts = c;
    });
    Object.defineProperty(window, 'location', {
      value: { assign: assignMock },
      writable: true,
    });
  });

  it('renders nothing when there are no contexts', async () => {
    vi.mocked(delegationApi.getContexts).mockResolvedValue({
      capabilities: null,
      sections: null,
      actingAsUserId: null,
      contexts: [],
    });
    await act(async () => {
      render(<DelegationBanner />);
    });
    expect(screen.queryByText(/Viewing:/)).not.toBeInTheDocument();
  });

  it('renders nothing when unauthenticated and does not call the API', async () => {
    state.isAuthenticated = false;
    await act(async () => {
      render(<DelegationBanner />);
    });
    expect(delegationApi.getContexts).not.toHaveBeenCalled();
    expect(screen.queryByText(/Viewing:/)).not.toBeInTheDocument();
  });

  it('shows the switcher and switches context on selection', async () => {
    state.availableContexts = [
      { userId: 'u1', label: 'Me', isSelf: true, ownerHas2FA: false },
      { userId: 'o1', label: 'Owner One', isSelf: false, ownerHas2FA: false },
    ];
    vi.mocked(delegationApi.getContexts).mockResolvedValue({
      capabilities: null,
      sections: null,
      actingAsUserId: null,
      contexts: state.availableContexts,
    });
    vi.mocked(delegationApi.switchContext).mockResolvedValue({
      actingAsUserId: 'o1',
    });

    await act(async () => {
      render(<DelegationBanner />);
    });
    expect(await screen.findByText(/Viewing:/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Switch account'), {
        target: { value: 'o1' },
      });
    });

    await waitFor(() =>
      expect(delegationApi.switchContext).toHaveBeenCalledWith('o1'),
    );
    expect(assignMock).toHaveBeenCalledWith('/dashboard');
  });

  it('auto-picks the only owner context for a pure delegate', async () => {
    vi.mocked(delegationApi.getContexts).mockResolvedValue({
      capabilities: null,
      sections: null,
      actingAsUserId: null,
      contexts: [
        { userId: 'o1', label: 'Owner', isSelf: false, ownerHas2FA: false },
      ],
    });
    vi.mocked(delegationApi.switchContext).mockResolvedValue({
      actingAsUserId: 'o1',
    });

    await act(async () => {
      render(<DelegationBanner />);
    });

    await waitFor(() =>
      expect(delegationApi.switchContext).toHaveBeenCalledWith('o1'),
    );
  });

  it('surfaces a 2FA-required error without switching', async () => {
    state.availableContexts = [
      { userId: 'u1', label: 'Me', isSelf: true, ownerHas2FA: false },
      { userId: 'o1', label: 'Owner', isSelf: false, ownerHas2FA: true },
    ];
    vi.mocked(delegationApi.getContexts).mockResolvedValue({
      capabilities: null,
      sections: null,
      actingAsUserId: null,
      contexts: state.availableContexts,
    });
    vi.mocked(delegationApi.switchContext).mockRejectedValue({
      response: { data: { message: 'DELEGATE_2FA_REQUIRED' } },
    });
    const toast = (await import('react-hot-toast')).default;

    await act(async () => {
      render(<DelegationBanner />);
    });
    await screen.findByText(/Viewing:/);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Switch account'), {
        target: { value: 'o1' },
      });
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(assignMock).not.toHaveBeenCalled();
  });
});
