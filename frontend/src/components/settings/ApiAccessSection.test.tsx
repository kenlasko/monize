import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ApiAccessSection } from './ApiAccessSection';

vi.mock('@/lib/auth', () => ({
  authApi: {
    getTokens: vi.fn().mockResolvedValue([]),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
    getSelfProfile: vi.fn(),
    beginOidcReauth: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  default: { post: vi.fn() },
}));

// The real modal verifies against the server; this stand-in shows which
// purpose it was opened for and lets a test finish or cancel the step-up.
vi.mock('@/components/auth/StepUpAuthModal', () => ({
  StepUpAuthModal: ({ isOpen, purpose, onVerified, onClose }: any) =>
    isOpen ? (
      <div data-testid="step-up-modal">
        <span>{purpose}</span>
        <button onClick={() => onVerified?.()}>Confirm step-up</button>
        <button onClick={onClose}>Dismiss step-up</button>
      </div>
    ) : null,
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
import apiClient from '@/lib/api';
import { useStepUpTokenStore } from '@/lib/stepUpToken';
import toast from 'react-hot-toast';

const STEP_UP_PURPOSE = 'personal-access-token';
const inFiveMinutes = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

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
    sessionStorage.clear();
    (authApi.getTokens as any).mockResolvedValue([]);
    (authApi.getSelfProfile as any).mockResolvedValue({
      id: 'user-1',
      authProvider: 'local',
      hasPassword: true,
    });
    // Most tests are about the form, not the second factor: start verified.
    useStepUpTokenStore.getState().clearAll();
    useStepUpTokenStore.getState().set(STEP_UP_PURPOSE, 'step-up-jwt', inFiveMinutes());
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

  it('reads when a token was last used through the locale-aware relative time', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    (authApi.getTokens as any).mockResolvedValue([
      { ...mockToken, lastUsedAt: threeDaysAgo },
      { ...mockToken, id: 'tok-2', name: 'Unused', lastUsedAt: null },
    ]);
    render(<ApiAccessSection />);

    // Intl.RelativeTimeFormat's wording, not a catalog "{count} days ago".
    expect(await screen.findByText(/Last used\s+3 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/Last used\s+Never/)).toBeInTheDocument();
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
      expect(screen.getByText('Token name is required')).toBeInTheDocument();
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
        'step-up-jwt',
      );
    });
  });

  it('defaults the expiry to 90 days', async () => {
    (authApi.createToken as any).mockResolvedValue({ ...mockToken, token: 'pat_x' });

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    expect(screen.getByRole('combobox')).toHaveValue('90');

    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(authApi.createToken).toHaveBeenCalled();
    });
    const sent = (authApi.createToken as any).mock.calls[0][0];
    const days = (new Date(sent.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it('sends expiresAt null when no expiration is chosen', async () => {
    (authApi.createToken as any).mockResolvedValue({ ...mockToken, token: 'pat_x' });

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(authApi.createToken).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'CLI', expiresAt: null }),
        'step-up-jwt',
      );
    });
  });

  it('sends the step-up token with the create request', async () => {
    (authApi.createToken as any).mockResolvedValue({ ...mockToken, token: 'pat_x' });

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(authApi.createToken).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'CLI', scopes: 'read' }),
        'step-up-jwt',
      );
    });
  });

  it('asks for step-up before creating a token, then creates it', async () => {
    // A PAT outlives the session that mints it, so the server refuses to mint
    // one on the session alone; the form must re-verify first.
    useStepUpTokenStore.getState().clearAll();
    (authApi.createToken as any).mockResolvedValue({ ...mockToken, token: 'pat_after_step_up' });

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(screen.getByTestId('step-up-modal')).toHaveTextContent(STEP_UP_PURPOSE);
    });
    expect(authApi.createToken).not.toHaveBeenCalled();

    // What the real modal does on success: store the token, then report back.
    useStepUpTokenStore.getState().set(STEP_UP_PURPOSE, 'fresh-step-up', inFiveMinutes());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm step-up' }));

    await waitFor(() => {
      expect(authApi.createToken).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'CLI', scopes: 'read' }),
        'fresh-step-up',
      );
    });
    await waitFor(() => {
      expect(screen.getByDisplayValue('pat_after_step_up')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('step-up-modal')).not.toBeInTheDocument();
  });

  it('creates nothing when the step-up is dismissed', async () => {
    useStepUpTokenStore.getState().clearAll();

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.click(getFormSubmitButton());
    await waitFor(() => {
      expect(screen.getByTestId('step-up-modal')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss step-up' }));

    await waitFor(() => {
      expect(screen.queryByTestId('step-up-modal')).not.toBeInTheDocument();
    });
    expect(authApi.createToken).not.toHaveBeenCalled();
  });

  it('asks again when the server says the step-up expired', async () => {
    (authApi.createToken as any).mockRejectedValue({
      response: { data: { code: 'STEP_UP_EXPIRED', purpose: STEP_UP_PURPOSE } },
    });

    render(<ApiAccessSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create Token' })).toBeInTheDocument();
    });
    await openCreateModal();
    fireEvent.change(screen.getByLabelText('Token Name'), { target: { value: 'CLI' } });
    fireEvent.click(getFormSubmitButton());

    await waitFor(() => {
      expect(screen.getByTestId('step-up-modal')).toBeInTheDocument();
    });
    expect(useStepUpTokenStore.getState().getValid(STEP_UP_PURPOSE)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('finishes an identity-provider step-up and reopens the form as it was', async () => {
    useStepUpTokenStore.getState().clearAll();
    sessionStorage.setItem(
      'stepUpOidcPending',
      JSON.stringify({
        purpose: STEP_UP_PURPOSE,
        payload: { name: 'Claude', expiryDays: '30', scopes: ['read', 'write'] },
      }),
    );
    sessionStorage.setItem('oidcReauthArtifact', 'reauth-artifact');
    (apiClient.post as any).mockResolvedValue({
      data: { stepUpToken: 'oidc-step-up', expiresAt: inFiveMinutes() },
    });

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/auth/step-up', {
        purpose: STEP_UP_PURPOSE,
        oidcReauthToken: 'reauth-artifact',
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Token Name')).toHaveValue('Claude');
    });
    expect(screen.getByRole('checkbox', { name: /Write/ })).toBeChecked();
    expect(useStepUpTokenStore.getState().getValid(STEP_UP_PURPOSE)).toBe('oidc-step-up');
  });

  it('says so when the identity-provider step-up cannot be confirmed', async () => {
    sessionStorage.setItem(
      'stepUpOidcPending',
      JSON.stringify({ purpose: STEP_UP_PURPOSE }),
    );
    (apiClient.post as any).mockRejectedValue(new Error('spent'));

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to confirm re-authentication');
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
    const multiScopeToken = { ...mockToken, scopes: 'read,write' };
    (authApi.getTokens as any).mockResolvedValue([multiScopeToken]);

    render(<ApiAccessSection />);

    await waitFor(() => {
      expect(screen.getByText('read')).toBeInTheDocument();
      expect(screen.getByText('write')).toBeInTheDocument();
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
