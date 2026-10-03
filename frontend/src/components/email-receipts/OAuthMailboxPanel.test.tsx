import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { OAuthMailboxPanel } from './OAuthMailboxPanel';
import { makeOAuthMailbox } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ start: vi.fn(), disconnect: vi.fn(), updateSettings: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    oauth: { start: api.start, disconnect: api.disconnect },
    mailbox: { updateSettings: api.updateSettings, get: api.get },
  },
}));

const assign = vi.fn();
const originalLocation = window.location;
const onChanged = vi.fn();
const providers = { google: true, microsoft: false, redirectUri: 'https://app/cb' };

async function renderPanel(
  mailbox = makeOAuthMailbox(),
  available: typeof providers | null = providers,
) {
  await act(async () => {
    render(<OAuthMailboxPanel mailbox={mailbox} providers={available} onChanged={onChanged} />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

describe('OAuthMailboxPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('says who the mailbox is connected as and shows no host, port or password fields', async () => {
    await renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Connected to Google as me@gmail.com.');
    expect(screen.queryByLabelText('IMAP server')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('links to where the grant is revoked at the provider', async () => {
    await renderPanel();
    const link = screen.getByRole('link', { name: 'Open Google account permissions' });
    expect(link).toHaveAttribute('href', 'https://myaccount.google.com/permissions');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('links to the Microsoft permissions page for a Microsoft mailbox', async () => {
    await renderPanel(makeOAuthMailbox({ oauthProvider: 'microsoft', username: 'me@contoso.com' }), {
      google: false,
      microsoft: true,
      redirectUri: 'x',
    });
    expect(screen.getByRole('link', { name: 'Open Microsoft app permissions' })).toHaveAttribute(
      'href',
      'https://myapps.microsoft.com',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Connected to Microsoft 365 as me@contoso.com.');
  });

  it('reconnects through the same flow as connecting', async () => {
    api.start.mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/auth' });
    await renderPanel();
    await click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(api.start).toHaveBeenCalledWith('google');
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/auth');
  });

  it('does not offer to reconnect a provider the operator no longer configures', async () => {
    await renderPanel(makeOAuthMailbox(), { google: false, microsoft: false, redirectUri: 'x' });
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('offers reconnect when the providers could not be read, leaving the refusal to the server', async () => {
    await renderPanel(makeOAuthMailbox(), null);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('flags a mailbox whose token is gone and offers no disconnect for it', async () => {
    await renderPanel(makeOAuthMailbox({ oauthConnected: false }));
    expect(screen.getByRole('alert')).toHaveTextContent('The connection to Google is not active');
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  describe('disconnect', () => {
    it('asks first and deletes nothing when cancelled', async () => {
      await renderPanel();
      await click(screen.getByRole('button', { name: 'Disconnect' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/delete its stored access to Google/)).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects on confirmation and hands the refreshed mailbox up', async () => {
      const after = makeOAuthMailbox({ oauthConnected: false, enabled: false });
      api.disconnect.mockResolvedValue(undefined);
      api.get.mockResolvedValue(after);
      await renderPanel();
      await click(screen.getByRole('button', { name: 'Disconnect' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
      expect(api.disconnect).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Mailbox disconnected');
      expect(onChanged).toHaveBeenCalledWith(after);
    });

    it('names the failure in a toast', async () => {
      api.disconnect.mockRejectedValue({ response: { data: { message: 'Nope' } } });
      await renderPanel();
      await click(screen.getByRole('button', { name: 'Disconnect' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
      expect(toast.error).toHaveBeenCalledWith('Nope');
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe('settings', () => {
    it('sends only the settings that changed, through PATCH', async () => {
      const saved = makeOAuthMailbox({ enabled: false });
      api.updateSettings.mockResolvedValue(saved);
      await renderPanel();
      expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
      await click(screen.getByRole('switch', { name: 'Read the mailbox automatically' }));
      await click(screen.getByRole('button', { name: 'Save settings' }));
      expect(api.updateSettings).toHaveBeenCalledWith({ enabled: false });
      expect(onChanged).toHaveBeenCalledWith(saved);
      expect(toast.success).toHaveBeenCalledWith('Mailbox settings saved');
    });

    it('sends the folder, AI mode and auto-apply when they change', async () => {
      api.updateSettings.mockResolvedValue(makeOAuthMailbox());
      await renderPanel();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Folder'), { target: { value: ' Receipts ' } });
        fireEvent.change(screen.getByLabelText('AI mode'), { target: { value: 'automatic' } });
      });
      await click(screen.getByRole('switch', { name: 'Apply proposals automatically' }));
      await click(screen.getByRole('button', { name: 'Save settings' }));
      expect(api.updateSettings).toHaveBeenCalledWith({ folder: 'Receipts', aiMode: 'automatic', autoApply: true });
    });

    it('shows the server refusal beside the settings', async () => {
      api.updateSettings.mockRejectedValue({ response: { data: { message: 'Folder not found' } } });
      await renderPanel();
      await click(screen.getByRole('switch', { name: 'Read the mailbox automatically' }));
      await click(screen.getByRole('button', { name: 'Save settings' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Folder not found');
      expect(onChanged).not.toHaveBeenCalled();
    });
  });
});
