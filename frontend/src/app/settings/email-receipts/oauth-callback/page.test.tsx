import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, act } from '@/test/render';
import EmailReceiptsOAuthCallbackPage from './page';
import { makeOAuthMailbox } from '@/components/email-receipts/email-receipts-fixtures';

const api = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { oauth: api } }));
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const replace = vi.hoisted(() => vi.fn());
let query = '';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}));

async function renderCallback(search: string, strict = false) {
  query = search;
  await act(async () => {
    render(<EmailReceiptsOAuthCallbackPage />, strict ? { wrapper: StrictMode } : undefined);
  });
  await act(async () => {});
}

describe('EmailReceiptsOAuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('posts the code and state once and sends the user back to the settings on success', async () => {
    api.complete.mockResolvedValue(makeOAuthMailbox());
    await renderCallback('?code=the-code&state=the-state');
    expect(api.complete).toHaveBeenCalledTimes(1);
    expect(api.complete).toHaveBeenCalledWith('the-code', 'the-state');
    expect(toast.success).toHaveBeenCalledWith('Mailbox connected');
    expect(replace).toHaveBeenCalledWith('/settings/email-receipts');
    expect(screen.getByRole('status')).toHaveTextContent('Connected as me@gmail.com');
  });

  it('shows progress while the server exchanges the code', async () => {
    api.complete.mockReturnValue(new Promise(() => {}));
    await renderCallback('?code=c&state=s');
    expect(screen.getByText('Finishing the connection')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    // Nothing to click away to until it has finished.
    expect(screen.queryByRole('link', { name: 'Back to the email receipts settings' })).not.toBeInTheDocument();
  });

  it('posts once even when the effect runs twice, as it does in strict mode', async () => {
    api.complete.mockResolvedValue(makeOAuthMailbox());
    await renderCallback('?code=c&state=s', true);
    expect(api.complete).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/settings/email-receipts');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('takes the single-use code out of the address bar', async () => {
    window.history.replaceState(null, '', '/settings/email-receipts/oauth-callback?code=c&state=s');
    api.complete.mockResolvedValue(makeOAuthMailbox());
    await renderCallback('?code=c&state=s');
    expect(window.location.search).toBe('');
    // ... without turning the pending connection into "missing parameters".
    expect(screen.queryByText('This page was opened without a sign-in result')).not.toBeInTheDocument();
  });

  it('shows the server refusal and the way back, and does not redirect', async () => {
    api.complete.mockRejectedValue({ response: { data: { message: 'The sign-in link has expired. Start again.' } } });
    await renderCallback('?code=c&state=s');
    expect(screen.getByRole('alert')).toHaveTextContent('The mailbox could not be connected');
    expect(screen.getByRole('alert')).toHaveTextContent('The sign-in link has expired. Start again.');
    expect(screen.getByRole('link', { name: 'Back to the email receipts settings' })).toHaveAttribute(
      'href',
      '/settings/email-receipts',
    );
    expect(replace).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('uses a generic message when the server gave none', async () => {
    api.complete.mockRejectedValue({});
    await renderCallback('?code=c&state=s');
    expect(screen.getByRole('alert')).toHaveTextContent('Start again from the email receipts settings');
  });

  describe('what the provider sent back', () => {
    it('shows the provider error with its description and posts nothing', async () => {
      await renderCallback('?error=access_denied&error_description=The+user+denied+access');
      expect(api.complete).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('The provider reported: access_denied. The user denied access');
      expect(screen.getByRole('link', { name: 'Back to the email receipts settings' })).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it('shows a provider error that has no description', async () => {
      await renderCallback('?error=server_error');
      expect(screen.getByRole('alert')).toHaveTextContent('The provider reported: server_error.');
    });

    it('prefers the error when the provider also sent a code', async () => {
      await renderCallback('?error=access_denied&code=c&state=s');
      expect(api.complete).not.toHaveBeenCalled();
    });

    it('shows only a bounded amount of the provider text, as plain text', async () => {
      const long = 'x'.repeat(2000);
      await renderCallback(`?error=bad&error_description=${long}<b>bold</b>`);
      const alert = screen.getByRole('alert');
      expect(alert.textContent!.length).toBeLessThan(600);
      expect(alert.querySelector('b')).toBeNull();
    });

    it.each([['?state=s'], ['?code=c'], ['?code=&state=s'], ['']])(
      'says what is missing instead of a blank page for %j, and posts nothing',
      async (search) => {
        await renderCallback(search);
        expect(api.complete).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('This page was opened without a sign-in result');
        expect(screen.getByRole('link', { name: 'Back to the email receipts settings' })).toBeInTheDocument();
      },
    );
  });
});
