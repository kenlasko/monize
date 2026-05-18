import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { SharedAccessSection } from './SharedAccessSection';

vi.mock('@/lib/delegation', () => ({
  delegationApi: {
    listDelegates: vi.fn(),
    createDelegate: vi.fn(),
    setGrants: vi.fn(),
    revokeDelegate: vi.fn(),
    resetPassword: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { delegationApi } from '@/lib/delegation';
import { accountsApi } from '@/lib/accounts';
import toast from 'react-hot-toast';

const delegate = {
  id: 'g1',
  status: 'active',
  createdAt: '2026-01-01',
  delegate: {
    id: 'd1',
    email: 'd@e.f',
    firstName: null,
    lastName: null,
    hasPassword: true,
  },
  accountIds: [] as string[],
};

async function renderSection() {
  await act(async () => {
    render(<SharedAccessSection />);
  });
}

describe('SharedAccessSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(delegationApi.listDelegates).mockResolvedValue([{ ...delegate }]);
    vi.mocked(accountsApi.getAll).mockResolvedValue([
      { id: 'a1', name: 'Chequing' },
    ] as never);
  });

  it('lists delegates and their grantable accounts', async () => {
    await renderSection();
    expect(await screen.findByText('d@e.f')).toBeInTheDocument();
    expect(screen.getByText('Chequing')).toBeInTheDocument();
  });

  it('rejects a password that fails the complexity policy', async () => {
    await renderSection();
    await screen.findByText('d@e.f');

    fireEvent.change(screen.getByPlaceholderText('Delegate email'), {
      target: { value: 'new@x.y' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Set a password (optional)'),
      { target: { value: 'weak' } },
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Add delegate'));
    });

    expect(toast.error).toHaveBeenCalled();
    expect(delegationApi.createDelegate).not.toHaveBeenCalled();
  });

  it('creates a delegate with a policy-compliant password', async () => {
    vi.mocked(delegationApi.createDelegate).mockResolvedValue({
      id: 'g2',
      delegateUserId: 'd2',
      email: 'new@x.y',
      invited: false,
    });
    await renderSection();
    await screen.findByText('d@e.f');

    fireEvent.change(screen.getByPlaceholderText('Delegate email'), {
      target: { value: 'new@x.y' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Set a password (optional)'),
      { target: { value: 'StrongPass1!xyz' } },
    );
    await act(async () => {
      fireEvent.click(screen.getByText('Add delegate'));
    });

    await waitFor(() =>
      expect(delegationApi.createDelegate).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@x.y',
          password: 'StrongPass1!xyz',
          sendInvite: false,
        }),
      ),
    );
  });

  it('toggles a per-account READ grant', async () => {
    vi.mocked(delegationApi.setGrants).mockResolvedValue();
    await renderSection();
    await screen.findByText('d@e.f');

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /Read access to Chequing/i }));
    });

    expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', ['a1']);
  });
});
