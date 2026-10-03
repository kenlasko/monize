import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { MailboxSection } from './MailboxSection';
import { makeMailbox, makeOAuthMailbox } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(), providers: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    mailbox: { get: api.get, upsert: vi.fn(), test: vi.fn(), pollNow: vi.fn(), remove: vi.fn(), updateSettings: vi.fn() },
    oauth: { providers: api.providers, start: vi.fn(), disconnect: vi.fn() },
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

async function renderSection() {
  await act(async () => {
    render(<MailboxSection />);
  });
  await act(async () => {});
}

describe('MailboxSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.providers.mockResolvedValue({ google: true, microsoft: true, redirectUri: 'https://app/cb' });
  });

  it('warns that the mailbox should be a dedicated one', async () => {
    api.get.mockResolvedValue(null);
    await renderSection();
    expect(screen.getByRole('note')).toHaveTextContent(/Every message in the folder is read/);
  });

  it('offers the connect buttons and the manual form when there is no mailbox', async () => {
    api.get.mockResolvedValue(null);
    await renderSection();
    expect(screen.getByRole('button', { name: 'Connect with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with Microsoft' })).toBeInTheDocument();
    expect(screen.getByLabelText('IMAP server')).toBeInTheDocument();
    // No mailbox, so no status line and no poll or delete.
    expect(screen.queryByRole('button', { name: 'Poll now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete mailbox' })).not.toBeInTheDocument();
  });

  it('offers only the providers the operator configured', async () => {
    api.providers.mockResolvedValue({ google: false, microsoft: true, redirectUri: 'x' });
    api.get.mockResolvedValue(null);
    await renderSection();
    expect(screen.queryByRole('button', { name: 'Connect with Google' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with Microsoft' })).toBeInTheDocument();
  });

  it('shows the manual form alone when no provider is configured', async () => {
    api.providers.mockResolvedValue({ google: false, microsoft: false, redirectUri: 'x' });
    api.get.mockResolvedValue(null);
    await renderSection();
    expect(screen.queryByRole('button', { name: /Connect with/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('IMAP server')).toBeInTheDocument();
  });

  it('says so, and keeps the manual form, when the providers could not be read', async () => {
    api.providers.mockRejectedValue(new Error('boom'));
    api.get.mockResolvedValue(null);
    await renderSection();
    expect(screen.getByRole('status')).toHaveTextContent(/could not be checked/);
    expect(screen.getByLabelText('IMAP server')).toBeInTheDocument();
  });

  it('shows a password mailbox with its form, status and actions', async () => {
    api.get.mockResolvedValue(makeMailbox({ lastPolledAt: '2026-09-10T10:00:00.000Z' }));
    await renderSection();
    expect((screen.getByLabelText('IMAP server') as HTMLInputElement).value).toBe('imap.example.com');
    expect(screen.getByRole('button', { name: 'Poll now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete mailbox' })).toBeInTheDocument();
  });

  it('shows an OAuth mailbox as connected, in place of the manual form', async () => {
    api.get.mockResolvedValue(makeOAuthMailbox());
    await renderSection();
    expect(screen.getByRole('status')).toHaveTextContent('Connected to Google as me@gmail.com.');
    expect(screen.queryByLabelText('IMAP server')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect with Microsoft' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Poll now' })).toBeInTheDocument();
  });

  it('warns when this server cannot encrypt a secret', async () => {
    api.get.mockResolvedValue(makeMailbox({ encryptionConfigured: false }));
    await renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot encrypt secrets/);
  });

  it('does not claim encryption is missing when it is configured', async () => {
    api.get.mockResolvedValue(makeMailbox());
    await renderSection();
    expect(screen.queryByText(/cannot encrypt secrets/)).not.toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as "no mailbox"', async () => {
    api.get.mockRejectedValueOnce(new Error('boom'));
    await renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent('The mailbox could not be loaded');
    expect(screen.queryByLabelText('IMAP server')).not.toBeInTheDocument();

    api.get.mockResolvedValue(makeMailbox());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await act(async () => {});
    expect((screen.getByLabelText('IMAP server') as HTMLInputElement).value).toBe('imap.example.com');
  });

  it('returns to the empty form after the mailbox is deleted', async () => {
    const remove = (await import('@/lib/email-receipts-api')).emailReceiptsApi.mailbox.remove as ReturnType<typeof vi.fn>;
    remove.mockResolvedValue(undefined);
    api.get.mockResolvedValue(makeMailbox());
    await renderSection();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete mailbox' }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement);
    });
    await act(async () => {});
    expect((screen.getByLabelText('IMAP server') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Delete mailbox' })).not.toBeInTheDocument();
  });
});
