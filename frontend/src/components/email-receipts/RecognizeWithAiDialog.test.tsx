import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouter } from 'next/navigation';
import { render, renderHook, screen, fireEvent, act, within } from '@/test/render';
import { RecognizeWithAiDialog } from './RecognizeWithAiDialog';
import { makeDetail, makeReceipt } from './email-receipts-fixtures';
import { peekChatHandoff } from '@/lib/ai-chat-handoff';

const api = vi.hoisted(() => ({ askAi: vi.fn(), get: vi.fn() }));
const txApi = vi.hoisted(() => ({ getAll: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: { receipts: { askAi: api.askAi, get: api.get } },
}));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: txApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const tx = { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' };
const onClose = vi.fn();
const onChanged = vi.fn();

const pickerTx = (id: string, payee: string) => ({
  id,
  transactionDate: '2026-09-02',
  payeeName: payee,
  amount: '-12.0000',
  currencyCode: 'USD',
  description: null,
  isTransfer: false,
  isVoid: false,
});

async function open(receipt = makeReceipt({ id: 'r-1', subject: 'Order 123', status: 'review', displayState: 'dismissed', transaction: tx }), assistantReady = true) {
  await act(async () => {
    render(<RecognizeWithAiDialog receipt={receipt} assistantReady={assistantReady} onClose={onClose} onChanged={onChanged} />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

// The mocked router is one object for the whole run (`test/setup.ts`); it is
// read once here, outside any component, so no hook is called from a helper.
const router = vi.mocked(renderHook(() => useRouter()).result.current);

const handoffIdFromPush = (): string => {
  const url = router.push.mock.calls.at(-1)?.[0] as string;
  return url.replace('/ai?handoff=', '');
};

describe('RecognizeWithAiDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.askAi.mockResolvedValue({ ok: true, requestId: 'req-1', transactionId: 'tx-1' });
    api.get.mockResolvedValue(
      makeDetail({
        id: 'r-1',
        subject: 'Order 123',
        fromAddress: 'orders@allegro.pl',
        receivedAt: '2026-09-10T10:00:00.000Z',
        bodyText: 'Widget 12.00\nOrder total: 25.00',
        transaction: tx,
        candidates: [
          { ...tx, id: 'c-1', description: 'Candidate one' },
          { ...tx, id: 'c-2', amount: -26, description: null },
        ],
      }),
    );
    txApi.getAll.mockResolvedValue({
      data: [pickerTx('p-1', 'Shop A'), pickerTx('p-2', 'Shop B')],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1, hasMore: false },
    });
  });

  describe('an email that already has a transaction', () => {
    it('asks for confirmation showing that transaction, and asks nothing before it', async () => {
      await open();
      const dialog = screen.getByRole('dialog', { name: 'Recognize with AI' });
      expect(dialog).toHaveTextContent('Allegro');
      expect(dialog).toHaveTextContent('$25.00');
      expect(api.askAi).not.toHaveBeenCalled();
    });

    it('queues the request for that transaction and opens the chat with the email attached and the message staged', async () => {
      await open();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(api.askAi).toHaveBeenCalledWith('r-1', undefined);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/ai\?handoff=[0-9a-f-]{36}$/));
      expect(onClose).toHaveBeenCalledTimes(1);

      // Parked in memory for the chat page: a text file and a draft, not a sent message.
      const handoff = peekChatHandoff(handoffIdFromPush());
      expect(handoff?.files).toHaveLength(1);
      const file = handoff!.files[0];
      expect(file.name).toBe('order-email-2026-09-10.txt');
      expect(file.type).toBe('text/plain');
      const text = await file.text();
      expect(text).toContain('From: orders@allegro.pl');
      expect(text).toContain('Subject: Order 123');
      expect(text).toContain('Date: 2026-09-10T10:00:00.000Z');
      expect(text).toContain('Widget 12.00\nOrder total: 25.00');
      expect(handoff?.draft).toContain('Recognize the products, quantities and prices in the attached order email');
      expect(handoff?.draft).toContain('Allegro');
      expect(handoff?.draft).toContain('$25.00');
      expect(handoff?.draft).toContain('Claim AI review request req-1');
    });

    it('lets the person choose another transaction, and queues the request for it', async () => {
      await open();
      await click(screen.getByRole('button', { name: 'Choose another transaction' }));
      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
      expect(api.askAi).not.toHaveBeenCalled();

      await click(screen.getAllByRole('button', { name: 'Use this transaction' })[1]);

      expect(api.askAi).toHaveBeenCalledWith('r-1', 'p-2');
      expect(router.push).toHaveBeenCalled();
    });

    it('goes back from the picker to the confirmation', async () => {
      await open();
      await click(screen.getByRole('button', { name: 'Choose another transaction' }));
      await click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByText(/Continue with this transaction\?/)).toBeInTheDocument();
    });
  });

  describe('an email with no transaction', () => {
    it('opens the picker straight away', async () => {
      await open(makeReceipt({ id: 'r-1', status: 'unmatched' }));
      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

      await click(screen.getAllByRole('button', { name: 'Use this transaction' })[0]);
      expect(api.askAi).toHaveBeenCalledWith('r-1', 'p-1');
    });
  });

  describe('an ambiguous email', () => {
    const ambiguous = () => makeReceipt({ id: 'r-1', status: 'ambiguous' });

    it('lists its candidates first and queues the request for the chosen one', async () => {
      await open(ambiguous());
      expect(screen.getByRole('heading', { name: 'Which transaction did the email pay for?' })).toBeInTheDocument();
      expect(screen.getByText('Candidate one')).toBeInTheDocument();
      expect(txApi.getAll).not.toHaveBeenCalled();

      await click(screen.getAllByRole('button', { name: 'Use this transaction' })[0]);
      expect(api.askAi).toHaveBeenCalledWith('r-1', 'c-1');
    });

    it('offers the full picker after the candidates, and back again', async () => {
      await open(ambiguous());
      await click(screen.getByRole('button', { name: 'Search other transactions' }));
      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByText('Candidate one')).toBeInTheDocument();
    });

    it('says the candidates could not be loaded, and retries', async () => {
      api.get.mockRejectedValueOnce(new Error('down'));
      await open(ambiguous());
      expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
      await click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByText('Candidate one')).toBeInTheDocument();
    });
  });

  describe('the outcomes', () => {
    it('with no assistant that can answer, says the request is queued for an agent and links to the inbox, opening no chat', async () => {
      await open(undefined, false);
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('Queued: no AI assistant is available');
      expect(screen.getByRole('status')).toHaveTextContent('for example over MCP');
      expect(screen.getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
      expect(router.push).not.toHaveBeenCalled();
      expect(api.get).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('says the request is queued when the email could not be read for the chat, and opens no chat', async () => {
      api.get.mockRejectedValue(new Error('down'));
      await open();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('could not be opened in the chat');
      expect(screen.getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
      expect(router.push).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and keeps the dialog on its step, queueing nothing", async () => {
      api.askAi.mockRejectedValue({ response: { data: { message: 'A transfer cannot be linked to an email.' } } });
      await open();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(screen.getByRole('alert')).toHaveTextContent('A transfer cannot be linked to an email.');
      expect(screen.getByText(/Continue with this transaction\?/)).toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    });

    it('names a failure that carries no message', async () => {
      api.askAi.mockRejectedValue(new Error('network'));
      await open();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not start the recognition|network/);
    });

    it('closes from the Cancel button', async () => {
      await open();
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
