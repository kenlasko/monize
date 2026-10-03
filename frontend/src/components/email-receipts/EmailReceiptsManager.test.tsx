import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeDetail, makeMailbox, makeParser, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  reprocess: vi.fn(),
  link: vi.fn(),
  ignore: vi.fn(),
  remove: vi.fn(),
  askAi: vi.fn(),
  draftParser: vi.fn(),
  mailboxGet: vi.fn(),
  parserCreate: vi.fn(),
  parserTest: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ configured: true }));
const transactionsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: {
      list: api.list,
      get: api.get,
      reprocess: api.reprocess,
      link: api.link,
      ignore: api.ignore,
      remove: api.remove,
      askAi: api.askAi,
      draftParser: api.draftParser,
    },
    mailbox: { get: api.mailboxGet },
    parsers: { create: api.parserCreate, test: api.parserTest },
  },
}));
vi.mock('@/hooks/useAiConfigured', () => ({
  useAiConfigured: () => ({ configured: assistant.configured, resolved: true }),
}));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi,
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi,
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const tx = { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' };

const unmatched = makeReceipt({ id: 'r-unmatched', subject: 'Order unmatched', status: 'unmatched' });
const noParser = makeReceipt({ id: 'r-noparser', subject: 'Order no parser', status: 'no_parser', fromAddress: 'orders@shop.example', fromDomain: 'shop.example' });
const ambiguous = makeReceipt({ id: 'r-ambiguous', subject: 'Order ambiguous', status: 'ambiguous' });
const proposed = makeReceipt({ id: 'r-proposed', subject: 'Order proposed', status: 'review', displayState: 'proposed', transaction: tx, parserName: 'Allegro parser' });
const applied = makeReceipt({ id: 'r-applied', subject: 'Order applied', status: 'review', displayState: 'applied', transaction: tx });
const ignored = makeReceipt({ id: 'r-ignored', subject: 'Order ignored', status: 'ignored' });
const skipped = makeReceipt({ id: 'r-skipped', subject: 'Order skipped', status: 'skipped' });
const pending = makeReceipt({ id: 'r-pending', subject: 'Order pending', status: 'pending' });
const parseFailed = makeReceipt({ id: 'r-failed', subject: 'Order failed', status: 'parse_failed' });
const conflict = makeReceipt({ id: 'r-conflict', subject: 'Order conflict', status: 'review_conflict', transaction: tx });
const dismissed = makeReceipt({ id: 'r-dismissed', subject: 'Order dismissed', status: 'review', displayState: 'dismissed', transaction: tx });
const expired = makeReceipt({ id: 'r-expired', subject: 'Order expired', status: 'review', displayState: 'expired', transaction: tx });
const missing = makeReceipt({ id: 'r-missing', subject: 'Order missing', status: 'review', displayState: 'request_missing', transaction: tx });
const waiting = makeReceipt({ id: 'r-waiting', subject: 'Order waiting', status: 'review', displayState: 'pending_ai', transaction: tx });

const all = [unmatched, noParser, ambiguous, proposed, applied, ignored, skipped, pending];

async function renderManager() {
  await act(async () => {
    render(<EmailReceiptsManager />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const rowOf = (subject: string) => screen.getByRole('row', { name: new RegExp(subject) });

/** The row's own button, or the entry behind its "More actions" menu. */
function actionNames(subject: string): string[] {
  const row = rowOf(subject);
  const inline = within(row)
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
  return inline.filter((name) => name !== 'More actions');
}

async function runAction(subject: string, name: string) {
  const row = rowOf(subject);
  const direct = within(row).queryByRole('button', { name });
  if (direct) {
    await click(direct);
    return;
  }
  await click(within(row).getByRole('button', { name: 'More actions' }));
  await click(screen.getByRole('menuitem', { name }));
}

/** Every action a row offers, inline and in its menu. */
async function allActions(subject: string): Promise<string[]> {
  const row = rowOf(subject);
  const names = actionNames(subject);
  const more = within(row).queryByRole('button', { name: 'More actions' });
  if (more) {
    await click(more);
    const menu = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
    await click(more);
    return [...names, ...menu];
  }
  return names;
}

describe('EmailReceiptsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assistant.configured = true;
    transactionsApi.getAll.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1, hasMore: false },
    });
    api.list.mockResolvedValue(all);
    api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode: 'on_demand' }));
    payeesApi.getAll.mockResolvedValue([]);
    categoriesApi.getAll.mockResolvedValue([]);
  });

  describe('the list', () => {
    it('shows each email with its sender, state and matched transaction', async () => {
      await renderManager();
      expect(api.list).toHaveBeenCalledWith(undefined);
      const row = rowOf('Order proposed');
      expect(within(row).getByText('orders@allegro.pl')).toBeInTheDocument();
      expect(within(row).getByText('Waiting for approval')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: /\$25\.00.*Allegro|Allegro/ })).toHaveAttribute(
        'href',
        '/transactions?targetTransactionId=tx-1',
      );
      expect(within(rowOf('Order unmatched')).getByText('No transaction found', { selector: 'span' })).toBeInTheDocument();
      expect(within(rowOf('Order unmatched')).getByText('None yet')).toBeInTheDocument();
    });

    it('links to the review inbox and to the settings', async () => {
      await renderManager();
      expect(screen.getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
      expect(screen.getByRole('link', { name: 'Mailbox and parser settings' })).toHaveAttribute('href', '/settings/email-receipts');
    });

    it('says there are no emails only when the list loaded empty', async () => {
      api.list.mockResolvedValue([]);
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
    });

    it('invites connecting a mailbox when there is none', async () => {
      api.list.mockResolvedValue([]);
      api.mailboxGet.mockResolvedValue(null);
      await renderManager();
      expect(screen.getByRole('link', { name: 'Connect a mailbox' })).toHaveAttribute('href', '/settings/email-receipts');
    });

    it('does not invite connecting a mailbox when there is one, or when that could not be checked', async () => {
      api.list.mockResolvedValue([]);
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Connect a mailbox' })).not.toBeInTheDocument();
    });

    it('does not invite connecting a mailbox when one is connected', async () => {
      api.list.mockResolvedValue([]);
      await renderManager();
      expect(screen.getByText('No emails')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Connect a mailbox' })).not.toBeInTheDocument();
    });

    it('shows a failed load as an error with a retry, never as an empty list', async () => {
      api.list.mockRejectedValueOnce(new Error('boom'));
      await renderManager();
      expect(screen.getByRole('alert')).toHaveTextContent('The emails could not be loaded');
      expect(screen.queryByText('No emails')).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByRole('row', { name: /Order proposed/ })).toBeInTheDocument();
    });
  });

  describe('the status filter', () => {
    it('asks the server for the chosen status', async () => {
      await renderManager();
      await click(screen.getByRole('button', { name: 'Could not be read' }));
      expect(api.list).toHaveBeenLastCalledWith('parse_failed');
      expect(screen.getByRole('button', { name: 'Could not be read' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('never draws the previous filter\'s rows, nor offers their actions, while the new one loads', async () => {
      await renderManager();
      let resolve!: (value: unknown) => void;
      api.list.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await click(screen.getByRole('button', { name: 'No parser' }));
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
      expect(screen.getByText('Loading emails')).toBeInTheDocument();
      await act(async () => {
        resolve([noParser]);
      });
      expect(screen.getByRole('row', { name: /Order no parser/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
    });

    it('keeps the newest filter when an older request answers late', async () => {
      let resolveAll!: (value: unknown) => void;
      api.list.mockReturnValueOnce(new Promise((r) => (resolveAll = r)));
      await act(async () => {
        render(<EmailReceiptsManager />);
      });
      api.list.mockResolvedValueOnce([ignored]);
      await click(screen.getByRole('button', { name: 'Ignored' }));
      expect(screen.getByRole('row', { name: /Order ignored/ })).toBeInTheDocument();
      await act(async () => {
        resolveAll(all);
      });
      expect(screen.getByRole('row', { name: /Order ignored/ })).toBeInTheDocument();
      expect(screen.queryByRole('row', { name: /Order proposed/ })).not.toBeInTheDocument();
    });

    it('says which state is empty, apart from an empty mailbox', async () => {
      await renderManager();
      api.list.mockResolvedValueOnce([]);
      await click(screen.getByRole('button', { name: 'Skipped' }));
      expect(screen.getByText('No emails in this state')).toBeInTheDocument();
    });
  });

  describe('which actions each email offers', () => {
    it('offers everything for an email with no parser, including the AI drafts when AI is on', async () => {
      await renderManager();
      expect(await allActions('Order no parser')).toEqual(
        expect.arrayContaining(['View', 'Create parser', 'Draft parser with AI', 'Reprocess', 'Ignore', 'Delete']),
      );
    });

    it('offers "Recognize with AI" for an email nothing read, or whose request was dismissed, expired or lost', async () => {
      api.list.mockResolvedValue([...all, parseFailed, conflict, dismissed, expired, missing, waiting]);
      await renderManager();
      for (const subject of [
        'Order unmatched',
        'Order no parser',
        'Order ambiguous',
        'Order failed',
        'Order conflict',
        'Order dismissed',
        'Order expired',
        'Order missing',
      ]) {
        expect(await allActions(subject), subject).toContain('Recognize with AI');
      }
    });

    it('offers it for no email with a proposal waiting, an applied request, or one ignored, skipped or not yet read', async () => {
      api.list.mockResolvedValue([...all, waiting]);
      await renderManager();
      for (const subject of ['Order proposed', 'Order waiting', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending']) {
        expect(await allActions(subject), subject).not.toContain('Recognize with AI');
      }
    });

    it.each(['off', 'on_demand', 'automatic'] as const)(
      "offers it whatever the mailbox AI mode (%s): pressing it is the person's consent",
      async (aiMode) => {
        api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode }));
        await renderManager();
        expect(await allActions('Order unmatched')).toContain('Recognize with AI');
      },
    );

    it('offers it when the mailbox could not be read', async () => {
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(await allActions('Order unmatched')).toContain('Recognize with AI');
    });

    it('offers no draft-parser action when the AI mode is off', async () => {
      api.mailboxGet.mockResolvedValue(makeMailbox({ aiMode: 'off' }));
      await renderManager();
      expect(await allActions('Order no parser')).not.toContain('Draft parser with AI');
      expect(await allActions('Order no parser')).toContain('Create parser');
    });

    it('offers no draft-parser action when the mailbox could not be read, since "unknown" is not "on"', async () => {
      api.mailboxGet.mockRejectedValue(new Error('boom'));
      await renderManager();
      expect(await allActions('Order no parser')).not.toContain('Draft parser with AI');
    });

    it('offers no draft-parser action when there is no mailbox', async () => {
      api.mailboxGet.mockResolvedValue(null);
      await renderManager();
      expect(await allActions('Order no parser')).not.toContain('Draft parser with AI');
    });

    it('offers choosing a transaction for an email the matcher could not tie to one', async () => {
      await renderManager();
      expect(await allActions('Order ambiguous')).toContain('Choose transaction');
      expect(await allActions('Order unmatched')).toContain('Choose transaction');
      expect(await allActions('Order no parser')).toContain('Choose transaction');
    });

    it('offers no choosing once there is a proposal, or for a closed email', async () => {
      await renderManager();
      for (const subject of ['Order proposed', 'Order applied', 'Order ignored', 'Order skipped', 'Order pending']) {
        expect(await allActions(subject), subject).not.toContain('Choose transaction');
      }
    });

    it('offers nothing that changes an applied, ignored or skipped email but view and delete', async () => {
      await renderManager();
      for (const subject of ['Order applied', 'Order ignored', 'Order skipped']) {
        expect((await allActions(subject)).sort(), subject).toEqual(['Delete', 'View']);
      }
    });

    it('offers no reprocess for an email still waiting to be read', async () => {
      await renderManager();
      expect(await allActions('Order pending')).not.toContain('Reprocess');
    });
  });

  describe('view and link', () => {
    it('opens the detail dialog for the email', async () => {
      api.get.mockResolvedValue(makeDetail({ id: 'r-proposed', subject: 'Order proposed' }));
      await renderManager();
      await runAction('Order proposed', 'View');
      expect(api.get).toHaveBeenCalledWith('r-proposed');
      expect(screen.getByRole('dialog', { name: 'Email receipt' })).toBeInTheDocument();
    });

    it('links an ambiguous email to a candidate from the dialog and refreshes the list', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          id: 'r-ambiguous',
          status: 'ambiguous',
          candidates: [{ id: 'tx-9', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro', description: null }],
        }),
      );
      api.link.mockResolvedValue(makeDetail({ id: 'r-ambiguous', status: 'review', displayState: 'proposed', transaction: tx }));
      await renderManager();
      await runAction('Order ambiguous', 'Choose transaction');
      expect(api.list).toHaveBeenCalledTimes(1);
      await click(screen.getByRole('button', { name: 'Link to this transaction' }));
      expect(api.link).toHaveBeenCalledWith('r-ambiguous', 'tx-9');
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('reprocess', () => {
    it('reprocesses the email and refreshes the list', async () => {
      api.reprocess.mockResolvedValue(makeDetail());
      await renderManager();
      await runAction('Order unmatched', 'Reprocess');
      expect(api.reprocess).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email reprocessed');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names a refusal and still refreshes the list', async () => {
      api.reprocess.mockRejectedValue({ response: { data: { message: 'This email could not be read' } } });
      await renderManager();
      await runAction('Order unmatched', 'Reprocess');
      expect(screen.getByRole('alert')).toHaveTextContent('This email could not be read');
    });
  });

  describe('Recognize with AI', () => {
    beforeEach(() => {
      api.list.mockResolvedValue([dismissed, unmatched]);
      api.askAi.mockResolvedValue({ ok: true, requestId: 'req-1', transactionId: 'tx-1' });
      api.get.mockResolvedValue(makeDetail({ id: 'r-dismissed', transaction: tx, bodyText: 'Widget 12.00' }));
    });

    it("asks to confirm the email's own transaction, queues the request, reloads the list and opens the chat", async () => {
      await renderManager();
      await runAction('Order dismissed', 'Recognize with AI');
      expect(screen.getByRole('dialog')).toHaveTextContent(/Allegro/);
      expect(api.askAi).not.toHaveBeenCalled();

      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(api.askAi).toHaveBeenCalledWith('r-dismissed', undefined);
      expect(api.list).toHaveBeenCalledTimes(2);
      expect(useRouter().push).toHaveBeenCalledWith(expect.stringMatching(/^\/ai\?handoff=[0-9a-f-]{36}$/));
    });

    it('says the request waits in the review inbox when no assistant can answer', async () => {
      assistant.configured = false;
      await renderManager();
      await runAction('Order dismissed', 'Recognize with AI');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Recognize with AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('Queued');
      expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute(
        'href',
        '/ai-reviews',
      );
      expect(useRouter().push).not.toHaveBeenCalled();
    });

    it('opens the picker for an email with no transaction', async () => {
      await renderManager();
      await runAction('Order unmatched', 'Recognize with AI');
      expect(screen.getByRole('heading', { name: 'Choose the transaction for the AI' })).toBeInTheDocument();
    });
  });

  describe('parsers', () => {
    it('drafts a parser with the AI and says it reads nothing until approved, with a link to review it', async () => {
      api.draftParser.mockResolvedValue(makeParser({ name: 'shop.example parser', status: 'draft', source: 'ai' }));
      await renderManager();
      await runAction('Order no parser', 'Draft parser with AI');
      expect(api.draftParser).toHaveBeenCalledWith('r-noparser');
      const notice = screen.getByRole('status');
      expect(notice).toHaveTextContent('shop.example parser');
      expect(notice).toHaveTextContent('reads nothing until you review and approve it');
      expect(within(notice).getByRole('link', { name: 'Review it in the parser settings' })).toHaveAttribute(
        'href',
        '/settings/email-receipts',
      );
    });

    it('opens the parser editor prefilled with the sender domain and the email to test against', async () => {
      api.list.mockResolvedValue([noParser]);
      await renderManager();
      await runAction('Order no parser', 'Create parser');
      const dialog = screen.getByRole('dialog', { name: 'New parser' });
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('shop.example');
      expect((within(dialog).getByLabelText('Sender domains') as HTMLTextAreaElement).value).toBe('shop.example');
    });

    it('refreshes the list when a parser was created, and closes the editor', async () => {
      api.list.mockResolvedValue([noParser]);
      api.parserCreate.mockResolvedValue(makeParser());
      await renderManager();
      await runAction('Order no parser', 'Create parser');
      await click(screen.getByRole('button', { name: 'Save parser' }));
      expect(api.parserCreate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // The page's own list (the editor's test panel asks for its own, with a limit).
      const pageLists = api.list.mock.calls.filter(([, limit]) => limit === undefined);
      expect(pageLists).toHaveLength(2);
    });
  });

  describe('ignore and delete ask first', () => {
    it('ignores only after confirmation', async () => {
      api.ignore.mockResolvedValue(makeDetail());
      await renderManager();
      await runAction('Order unmatched', 'Ignore');
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/will propose nothing, and its open review request will be dismissed/)).toBeInTheDocument();
      expect(api.ignore).not.toHaveBeenCalled();
      await click(within(dialog).getByRole('button', { name: 'Ignore' }));
      expect(api.ignore).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email ignored');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the confirmation is cancelled', async () => {
      await renderManager();
      await runAction('Order unmatched', 'Ignore');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(api.ignore).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('deletes only after confirmation', async () => {
      api.remove.mockResolvedValue(undefined);
      await renderManager();
      await runAction('Order unmatched', 'Delete');
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/The stored email Order unmatched will be deleted/)).toBeInTheDocument();
      expect(api.remove).not.toHaveBeenCalled();
      await click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(api.remove).toHaveBeenCalledWith('r-unmatched');
      expect(toast.success).toHaveBeenCalledWith('Email deleted');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names a refused delete and keeps the list as the server has it', async () => {
      api.remove.mockRejectedValue({ response: { data: { message: 'Email not found' } } });
      await renderManager();
      await runAction('Order unmatched', 'Delete');
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Email not found');
    });
  });
});
