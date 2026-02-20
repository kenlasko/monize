import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ApiAccessSection } from './ApiAccessSection';

vi.mock('@/lib/auth', () => ({
  authApi: {
    getTokens: vi.fn().mockResolvedValue([]),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

// Mock Modal to render children directly when open
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

// Mock ConfirmDialog
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

import { authApi } from '@/lib/auth';
import toast from 'react-hot-toast';

const mockToken = {
  id: 'tok-1',
  name: 'Claude Desktop',
  tokenPrefix: 'pat_abcd',
  scopes: 'read,write',
  lastUsedAt: '2025-02-10T00:00:00Z',
  expiresAt: '2025-12-31T00:00:00Z',
  isRevoked: false,
  createdAt: '2025-01-01T00:00:00Z',
};

/** Open the create modal and return the submit button inside it */
async function openCreateModal() {
  fireEvent.click(screen.getByRole('button', { name: 'Create Token' }));
  await waitFor(() => {
    expect(screen.getByText('Create API Token')).toBeInTheDocument();
  });
}

/** Get the form submit button inside the modal (not the header button) */
function getFormSubmitButton() {
  const buttons = screen.getAllByRole('button', { name: 'Create Token' });
  // The last one is the form submit button inside the modal
  return buttons[buttons.length - 1];
}

describe('ApiAccessSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authApi.getTokens as any).mockResolvedValue([]);
  });

  it('renders the section heading and description', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('API Access')).toBeInTheDocument();
    });
    expect(screen.getByText(/personal access tokens/)).toBeInTheDocument();
  });

  it('displays the MCP Server URL', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('MCP Server URL')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(/\/api\/v1\/mcp$/)).toBeInTheDocument();
    expect(screen.getByText(/Use this URL when configuring MCP clients/)).toBeInTheDocument();
  });

  it('renders the Create Token button', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
  });

  it('shows empty state when no tokens exist', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText(/No API tokens yet/)).toBeInTheDocument();
    });
  });

  it('displays existing tokens', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });
    expect(screen.getByText('pat_abcd...')).toBeInTheDocument();
    expect(screen.getByText('read')).toBeInTheDocument();
    expect(screen.getByText('write')).toBeInTheDocument();
  });

  it('hides revoked tokens from the list', async () => {
    const revokedToken = { ...mockToken, isRevoked: true };
    (authApi.getTokens as any).mockResolvedValue([revokedToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText(/No API tokens yet/)).toBeInTheDocument();
    });
  });

  it('shows error toast when loading tokens fails', async () => {
    (authApi.getTokens as any).mockRejectedValue(new Error('Network error'));

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load API tokens');
    });
  });

  // --- Create Token Modal ---
  it('opens create modal when Create Token is clicked', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    expect(screen.getByLabelText('Token Name')).toBeInTheDocument();
    expect(screen.getByText('Scopes')).toBeInTheDocument();
    expect(screen.getByText('Expiration')).toBeInTheDocument();
  });

  it('shows validation error when name is empty', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    // Submit without entering a name
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Token name is required');
    });
  });

  it('creates token and shows the token value', async () => {
    const createdResult = {
      ...mockToken,
      token: 'pat_abcdef1234567890',
    };
    (authApi.createToken as any).mockResolvedValue(createdResult);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'My Token' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('Token Created')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('pat_abcdef1234567890')).toBeInTheDocument();
    // Token copy button is inside the modal alongside the token input
    const tokenInput = screen.getByDisplayValue('pat_abcdef1234567890');
    expect(tokenInput.parentElement?.querySelector('button')).toHaveTextContent('Copy');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('calls createToken API with correct data', async () => {
    const createdResult = {
      ...mockToken,
      token: 'pat_test',
    };
    (authApi.createToken as any).mockResolvedValue(createdResult);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'Test Token' } });

    // Read scope is checked by default - also check Write
    const writeCheckbox = screen.getByRole('checkbox', { name: /Write/ });
    fireEvent.click(writeCheckbox);

    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(authApi.createToken).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Token',
          scopes: 'read,write',
        }),
      );
    });
  });

  it('shows error toast when create fails', async () => {
    (authApi.createToken as any).mockRejectedValue(new Error('Limit reached'));

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'My Token' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create token');
    });
  });

  it('closes create modal when Done is clicked after creation', async () => {
    const createdResult = { ...mockToken, token: 'pat_test' };
    (authApi.createToken as any).mockResolvedValue(createdResult);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'My Token' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(screen.getByText('Token Created')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      expect(screen.queryByText('Token Created')).not.toBeInTheDocument();
    });
  });

  it('closes create modal when Cancel is clicked', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Create API Token')).not.toBeInTheDocument();
    });
  });

  // --- Scope validation ---
  it('shows validation error when no scopes selected', async () => {
    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'My Token' } });

    // Uncheck the default "read" scope
    const readCheckbox = screen.getByRole('checkbox', { name: /Read/ });
    fireEvent.click(readCheckbox);

    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Select at least one scope');
    });
  });

  // --- Revoke Token ---
  it('opens revoke confirmation when Revoke is clicked', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
      expect(screen.getByText('Revoke Token')).toBeInTheDocument();
    });
  });

  it('revokes token when confirmed', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);
    (authApi.revokeToken as any).mockResolvedValue({ message: 'Revoked' });

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    // Click the Revoke button in the confirm dialog
    const confirmBtn = screen.getAllByRole('button', { name: 'Revoke' });
    fireEvent.click(confirmBtn[confirmBtn.length - 1]);

    await waitFor(() => {
      expect(authApi.revokeToken).toHaveBeenCalledWith('tok-1');
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Token revoked');
    });
  });

  it('shows error toast when revoke fails', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);
    (authApi.revokeToken as any).mockRejectedValue(new Error('fail'));

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    const confirmBtn = screen.getAllByRole('button', { name: 'Revoke' });
    fireEvent.click(confirmBtn[confirmBtn.length - 1]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to revoke token');
    });
  });

  it('closes revoke dialog when Cancel is clicked', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  // --- Token display details ---
  it('shows expiry date for tokens with expiration', async () => {
    (authApi.getTokens as any).mockResolvedValue([mockToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText(/Expires/)).toBeInTheDocument();
    });
  });

  it('does not show expiry for tokens without expiration', async () => {
    const noExpiryToken = { ...mockToken, expiresAt: null };
    (authApi.getTokens as any).mockResolvedValue([noExpiryToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
  });

  it('shows scope badges for each scope', async () => {
    const multiScopeToken = { ...mockToken, scopes: 'read,write,reports' };
    (authApi.getTokens as any).mockResolvedValue([multiScopeToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('read')).toBeInTheDocument();
      expect(screen.getByText('write')).toBeInTheDocument();
      expect(screen.getByText('reports')).toBeInTheDocument();
    });
  });

  // --- Copy token ---
  it('copies token to clipboard after creation', async () => {
    const createdResult = { ...mockToken, token: 'pat_abc123' };
    (authApi.createToken as any).mockResolvedValue(createdResult);

    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });

    await openCreateModal();

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'Test' } });
    fireEvent.click(getFormSubmitButton());

    // Click the Copy button next to the token input (not the MCP URL copy button)
    const tokenInput = await waitFor(() => screen.getByDisplayValue('pat_abc123'));
    const tokenCopyBtn = tokenInput.parentElement?.querySelector('button') as HTMLButtonElement;
    expect(tokenCopyBtn).toHaveTextContent('Copy');

    fireEvent.click(tokenCopyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('pat_abc123');
      expect(toast.success).toHaveBeenCalledWith('Token copied to clipboard');
    });
  });
});
