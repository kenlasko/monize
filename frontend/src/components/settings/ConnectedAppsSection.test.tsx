import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
import { ConnectedAppsSection } from './ConnectedAppsSection';
import type { ConnectedApp } from '@/lib/oauth-connections';

vi.mock('@/lib/oauth-connections', () => ({
  oauthConnectionsApi: { list: vi.fn(), revoke: vi.fn() },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, onConfirm, onCancel, confirmLabel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <p>{title}</p>
        <p>{message}</p>
        <button onClick={onCancel}>Cancel</button>
        <button onClick={onConfirm}>{confirmLabel}</button>
      </div>
    ) : null,
}));

import { oauthConnectionsApi } from '@/lib/oauth-connections';
import toast from 'react-hot-toast';

const list = vi.mocked(oauthConnectionsApi.list);
const revoke = vi.mocked(oauthConnectionsApi.revoke);

function app(overrides: Partial<ConnectedApp> = {}): ConnectedApp {
  return {
    id: 'grant-1',
    clientId: 'client-1',
    clientName: 'Google SignIn',
    clientKnown: true,
    destinations: ['https://attacker-example.test'],
    scopes: ['read', 'write'],
    grantedAt: '2026-11-01T10:00:00.000Z',
    expiresAt: '2026-11-15T10:00:00.000Z',
    lastUsedAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  };
}

async function renderSection() {
  await act(async () => {
    render(<ConnectedAppsSection />);
  });
}

describe('ConnectedAppsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leads each app with where its authorizations go, and shows the name as self-chosen', async () => {
    list.mockResolvedValue([app()]);
    await renderSection();

    expect(screen.getByText('Connected Apps')).toBeInTheDocument();
    expect(screen.getByText('https://attacker-example.test')).toBeInTheDocument();
    expect(screen.getByText('Calls itself “Google SignIn”')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
    expect(screen.getByText(/Connected .*Last used .*Access ends/)).toBeInTheDocument();
  });

  it('says when an app has not been used and when its registration expired', async () => {
    list.mockResolvedValue([
      app({ lastUsedAt: null, grantedAt: null, expiresAt: null }),
      app({ id: 'grant-2', clientKnown: false, destinations: [], scopes: [] }),
      app({ id: 'grant-3', destinations: [] }),
    ]);
    await renderSection();

    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(screen.getByText(/Registration expired/)).toBeInTheDocument();
    expect(screen.getByText('Destination unknown')).toBeInTheDocument();
  });

  it('shows the empty state when nothing is connected', async () => {
    list.mockResolvedValue([]);
    await renderSection();

    expect(screen.getByText('No connected apps')).toBeInTheDocument();
  });

  it('never renders a failed read as an empty list, and retries on request', async () => {
    list.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([app()]);
    await renderSection();

    expect(screen.queryByText('No connected apps')).not.toBeInTheDocument();
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Could not load connected apps');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.getByText('https://attacker-example.test')).toBeInTheDocument();
  });

  it('revokes one app after confirmation and removes it from the list', async () => {
    list.mockResolvedValue([app(), app({ id: 'grant-2', clientName: 'Claude', destinations: ['https://claude.test'] })]);
    revoke.mockResolvedValue(undefined);
    await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Google SignIn' }));
    expect(screen.getByText('Revoke this app?')).toBeInTheDocument();
    expect(screen.getByText(/“Google SignIn” loses access/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    });

    expect(revoke).toHaveBeenCalledWith('grant-1');
    expect(toast.success).toHaveBeenCalledWith('App revoked');
    await waitFor(() => {
      expect(screen.queryByText('https://attacker-example.test')).not.toBeInTheDocument();
    });
    expect(screen.getByText('https://claude.test')).toBeInTheDocument();
  });

  it('cancelling the confirmation revokes nothing', async () => {
    list.mockResolvedValue([app()]);
    await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Google SignIn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('re-reads the list when a revoke fails', async () => {
    list.mockResolvedValueOnce([app()]).mockResolvedValueOnce([]);
    revoke.mockRejectedValue(new Error('gone'));
    await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Google SignIn' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    });

    expect(toast.error).toHaveBeenCalledWith('Could not revoke the app');
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No connected apps')).toBeInTheDocument();
  });
});
