import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ReceiptTransactionPicker } from './ReceiptTransactionPicker';

const api = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: api,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const onLink = vi.fn();

const tx = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  transactionDate: '2026-09-02',
  payeeName: 'Allegro',
  // Money crosses the wire as a string.
  amount: '-25.0000',
  currencyCode: 'USD',
  description: null,
  isTransfer: false,
  isVoid: false,
  ...overrides,
});

const page = (rows: unknown[], hasMore = false) => ({
  data: rows,
  pagination: { page: 1, limit: 50, total: rows.length, totalPages: 1, hasMore },
});

async function renderPicker(linkingId: string | null = null, receivedAt = '2026-09-01T23:30:00.000Z') {
  await act(async () => {
    render(<ReceiptTransactionPicker receivedAt={receivedAt} linkingId={linkingId} onLink={onLink} />);
  });
  await act(async () => {});
}

describe('ReceiptTransactionPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAll.mockResolvedValue(page([tx(), tx({ id: 'tx-2', payeeName: null, amount: '-7.5', description: 'Ticket https://shop.example/t/9' })]));
  });

  it('loads the matcher window: 3 days before the email day to 14 after, one bounded page', async () => {
    await renderPicker();
    expect(api.getAll).toHaveBeenCalledWith({ startDate: '2026-08-29', endDate: '2026-09-15', limit: 50 });
  });

  it('takes the window across a month and a year end without a Date', async () => {
    await renderPicker(null, '2026-12-25T10:00:00.000Z');
    expect(api.getAll).toHaveBeenCalledWith({ startDate: '2026-12-22', endDate: '2027-01-08', limit: 50 });
  });

  it('shows the date, payee, amount and description of each transaction', async () => {
    await renderPicker();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/Allegro/);
    expect(rows[0]).toHaveTextContent(/25\.00/);
    expect(rows[1]).toHaveTextContent(/no payee/);
    expect(rows[1]).toHaveTextContent(/7\.50/);
    expect(within(rows[1]).getByRole('link', { name: /shop\.example\/t\/9/ })).toHaveAttribute('href', 'https://shop.example/t/9');
  });

  it('never offers a transfer or a voided transaction, which the server refuses to link', async () => {
    api.getAll.mockResolvedValue(
      page([tx({ id: 'ok' }), tx({ id: 'tr', payeeName: 'Transfer', isTransfer: true }), tx({ id: 'vd', payeeName: 'Voided', isVoid: true })]),
    );
    await renderPicker();
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(1);
    expect(screen.queryByText(/Transfer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Voided/)).not.toBeInTheDocument();
  });

  it('asks for the typed search and only when it is submitted', async () => {
    await renderPicker();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: '  coffee ' } });
    });
    expect(api.getAll).toHaveBeenCalledTimes(1);
    api.getAll.mockResolvedValueOnce(page([tx({ id: 'tx-3', payeeName: 'Coffee Shop' })]));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    await act(async () => {});
    expect(api.getAll).toHaveBeenLastCalledWith({ startDate: '2026-08-29', endDate: '2026-09-15', limit: 50, search: 'coffee' });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText(/Coffee Shop/)).toBeInTheDocument();
  });

  it('says which kind of empty it is', async () => {
    api.getAll.mockResolvedValueOnce(page([]));
    await renderPicker();
    expect(screen.getByText('You have no transactions in this period that can be linked.')).toBeInTheDocument();
    api.getAll.mockResolvedValueOnce(page([]));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    await act(async () => {});
    expect(screen.getByText('No transaction in this period matches the search.')).toBeInTheDocument();
  });

  it('does not draw the previous search\'s rows, nor offer their Link buttons, while the new one loads', async () => {
    await renderPicker();
    let resolve!: (value: unknown) => void;
    api.getAll.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    expect(screen.getByText('Loading transactions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
    await act(async () => {
      resolve(page([tx({ id: 'new', payeeName: 'Newer' })]));
    });
    expect(screen.getByText(/Newer/)).toBeInTheDocument();
  });

  it('keeps the newest search when an older request answers late', async () => {
    let resolveFirst!: (value: unknown) => void;
    api.getAll.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    await act(async () => {
      render(<ReceiptTransactionPicker receivedAt="2026-09-01T10:00:00.000Z" linkingId={null} onLink={onLink} />);
    });
    api.getAll.mockResolvedValueOnce(page([tx({ id: 'b', payeeName: 'Second' })]));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'b' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    });
    await act(async () => {});
    await act(async () => {
      resolveFirst(page([tx({ id: 'a', payeeName: 'First' })]));
    });
    expect(screen.getByText(/Second/)).toBeInTheDocument();
    expect(screen.queryByText(/First/)).not.toBeInTheDocument();
  });

  it('hands the chosen transaction to onLink', async () => {
    await renderPicker();
    await act(async () => {
      fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'Link' }));
    });
    expect(onLink).toHaveBeenCalledWith('tx-2');
  });

  it('waits on every Link button while one link is in flight', async () => {
    await renderPicker('tx-1');
    for (const button of screen.getAllByRole('button', { name: /Link/ })) expect(button).toBeDisabled();
  });

  it('says the list is cut at one page and to search', async () => {
    api.getAll.mockResolvedValue(page([tx()], true));
    await renderPicker();
    expect(screen.getByText('Only the first 50 are shown. Use the search to narrow the list.')).toBeInTheDocument();
  });

  it('shows a failed read as an error with a retry, never as "no transactions"', async () => {
    api.getAll.mockRejectedValueOnce(new Error('boom'));
    await renderPicker();
    expect(screen.getByRole('alert')).toHaveTextContent('The transactions could not be loaded.');
    expect(screen.queryByText(/no transactions/)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await act(async () => {});
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  describe('in the "choose for AI" mode', () => {
    it('says the choice goes to the AI, with its own heading, help and button, over the same list', async () => {
      await act(async () => {
        render(<ReceiptTransactionPicker mode="ai" receivedAt="2026-09-01T23:30:00.000Z" linkingId={null} onLink={onLink} />);
      });
      await act(async () => {});

      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
      expect(screen.getByText(/the AI should split by the products/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Link' })).not.toBeInTheDocument();
      const buttons = screen.getAllByRole('button', { name: 'Use this transaction' });
      expect(buttons).toHaveLength(2);
      expect(api.getAll).toHaveBeenCalledWith({ startDate: '2026-08-29', endDate: '2026-09-15', limit: 50 });

      await act(async () => {
        fireEvent.click(buttons[0]);
      });
      expect(onLink).toHaveBeenCalledWith('tx-1');
    });
  });
});
