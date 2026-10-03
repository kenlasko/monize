import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { MailboxStatus } from './MailboxStatus';
import { makeMailbox } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ pollNow: vi.fn(), get: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { mailbox: api } }));

const onRefreshed = vi.fn();
const onDeleted = vi.fn();

async function renderStatus(mailbox = makeMailbox()) {
  await act(async () => {
    render(<MailboxStatus mailbox={mailbox} onRefreshed={onRefreshed} onDeleted={onDeleted} />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

describe('MailboxStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says "Never" for a mailbox that has not been polled, not a blank', async () => {
    await renderStatus();
    expect(screen.getAllByText('Never')).toHaveLength(2);
  });

  it('shows when it was last polled and last succeeded', async () => {
    await renderStatus(makeMailbox({ lastPolledAt: '2026-09-10T10:00:00.000Z', lastSuccessAt: '2026-09-09T10:00:00.000Z' }));
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
    expect(screen.getByText('Last poll').nextElementSibling?.textContent).toMatch(/2026|10/);
  });

  it('shows the last error as an alert, with its time when it has one', async () => {
    await renderStatus(makeMailbox({ lastError: 'Authentication failed', lastErrorAt: '2026-09-10T10:00:00.000Z' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Last error \(.+\): Authentication failed/);
  });

  it('shows an error that has no time', async () => {
    await renderStatus(makeMailbox({ lastError: 'Authentication failed', lastErrorAt: null }));
    expect(screen.getByRole('alert')).toHaveTextContent('Last error: Authentication failed');
  });

  it('shows no alert when the last poll was fine', async () => {
    await renderStatus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('poll now', () => {
    it('shows what the poll fetched, skipped and processed, and refreshes the status line', async () => {
      const refreshed = makeMailbox({ lastPolledAt: '2026-09-10T10:00:00.000Z' });
      api.pollNow.mockResolvedValue({ ok: true, fetched: 3, skipped: 1, processed: 2 });
      api.get.mockResolvedValue(refreshed);
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Poll now' }));
      expect(api.pollNow).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent('Poll finished: 3 emails stored, 1 skipped, 2 processed.');
      expect(onRefreshed).toHaveBeenCalledWith(refreshed);
    });

    it('singularises one email', async () => {
      api.pollNow.mockResolvedValue({ ok: true, fetched: 1, skipped: 0, processed: 0 });
      api.get.mockResolvedValue(makeMailbox());
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Poll now' }));
      expect(screen.getByRole('status')).toHaveTextContent('1 email stored');
    });

    it('keeps the result when only the refresh of the status line fails', async () => {
      api.pollNow.mockResolvedValue({ ok: true, fetched: 0, skipped: 0, processed: 0 });
      api.get.mockRejectedValue(new Error('boom'));
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Poll now' }));
      expect(screen.getByRole('status')).toHaveTextContent('Poll finished');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the reason when the server says the poll did not run', async () => {
      api.pollNow.mockResolvedValue({ ok: false, busy: true, fetched: 0, skipped: 0, processed: 0, error: 'The mailbox is being read right now.' });
      api.get.mockResolvedValue(makeMailbox());
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Poll now' }));
      expect(screen.getByRole('alert')).toHaveTextContent('The mailbox is being read right now.');
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('shows a failed request as an alert', async () => {
      api.pollNow.mockRejectedValue({ response: { data: { message: 'Too many requests' } } });
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Poll now' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests');
    });
  });

  describe('delete mailbox', () => {
    it('asks first and deletes nothing when cancelled', async () => {
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Delete mailbox' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/every stored email will be deleted/)).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.remove).not.toHaveBeenCalled();
      expect(onDeleted).not.toHaveBeenCalled();
    });

    it('deletes on confirmation', async () => {
      api.remove.mockResolvedValue(undefined);
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Delete mailbox' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(api.remove).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith('Mailbox deleted');
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });

    it('names a failure and keeps the mailbox', async () => {
      api.remove.mockRejectedValue({ response: { data: { message: 'Cannot delete' } } });
      await renderStatus();
      await click(screen.getByRole('button', { name: 'Delete mailbox' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(toast.error).toHaveBeenCalledWith('Cannot delete');
      expect(onDeleted).not.toHaveBeenCalled();
    });
  });
});
