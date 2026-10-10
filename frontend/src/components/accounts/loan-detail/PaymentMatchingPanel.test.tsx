import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { PaymentMatchingPanel, type LoanSettlementsState } from './PaymentMatchingPanel';
import { SETTLEMENTS_COLLAPSED_STORAGE_KEY } from './LoanSettlementsTable';
import type { Account, LoanSettlementRow } from '@/types/account';
import type { RuleRunPreview } from '@/types/transaction-rule-run';

const mockPush = vi.fn();
vi.mock('next/navigation', () => {
  let router: { push: typeof mockPush } | null = null;
  return { useRouter: () => (router ??= { push: mockPush }) };
});

const mockCreateRule = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    createPaymentMatchingRule: (...args: unknown[]) => mockCreateRule(...args),
  },
}));

const mockGetSchedule = vi.fn();
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getById: (...args: unknown[]) => mockGetSchedule(...args),
  },
}));

const mockGetRule = vi.fn();
const mockPreviewRun = vi.fn();
const mockRun = vi.fn();
vi.mock('@/lib/transaction-rules-api', () => ({
  transactionRulesApi: {
    getById: (...args: unknown[]) => mockGetRule(...args),
    previewRun: (...args: unknown[]) => mockPreviewRun(...args),
    run: (...args: unknown[]) => mockRun(...args),
  },
}));

const mockInvalidateBalanceCaches = vi.fn();
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  invalidateBalanceCaches: () => mockInvalidateBalanceCaches(),
}));

const LOAN: Account = {
  id: 'loan-1',
  accountType: 'MORTGAGE',
  name: 'Home',
  currencyCode: 'EUR',
  institution: 'ING',
  scheduledTransactionId: 'st-1',
  paymentMatchingRuleId: 'rule-1',
} as Account;

const SCHEDULE = {
  id: 'st-1',
  accountId: 'chq-1',
  account: { id: 'chq-1', name: 'Current account' },
  autoPost: false,
  startDate: '2024-01-01',
};

const settlement = (over: Partial<LoanSettlementRow> = {}): LoanSettlementRow => ({
  claimId: 'c-1',
  dueDate: '2024-01-01',
  postedDate: '2024-01-03',
  transactionId: 'tx-1',
  transactionStatus: 'UNRECONCILED',
  principal: 833.33,
  interest: 500,
  extraPrincipal: 0,
  debtBefore: 300000,
  installmentNumber: 1,
  ruleId: 'rule-1',
  ...over,
});

const preview = (over: Partial<RuleRunPreview> = {}): RuleRunPreview => ({
  matched: [],
  skipped: [],
  scanned: 0,
  conditionMatchedCount: 0,
  truncated: false,
  scannedThrough: null,
  scanOrder: 'oldest_first',
  fingerprint: 'fp',
  labels: { accounts: {}, categories: {}, payees: {}, tags: {}, rules: {} },
  ...over,
});

const matchedRow = (id: string, date: string) => ({
  transactionId: id,
  date,
  payeeName: 'ING HYPOTHEKEN',
  amount: -1333.33,
  currencyCode: 'EUR',
  changes: {},
});

const READY_EMPTY: LoanSettlementsState = { status: 'ready', rows: [] };

async function renderPanel(
  account: Account = LOAN,
  settlements: LoanSettlementsState = READY_EMPTY,
  onChanged = vi.fn(),
) {
  await act(async () => {
    render(<PaymentMatchingPanel account={account} settlements={settlements} onChanged={onChanged} />);
  });
  return onChanged;
}

async function clickProcess() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Process history' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSchedule.mockResolvedValue(SCHEDULE);
  mockGetRule.mockResolvedValue({ id: 'rule-1', name: 'Mortgage payment - Home' });
});

describe('PaymentMatchingPanel', () => {
  it('offers to create a rule when the loan has none, prefilled from the institution', async () => {
    mockCreateRule.mockResolvedValue({ id: 'rule-2', name: 'Mortgage payment - Home' });
    const onChanged = await renderPanel({ ...LOAN, paymentMatchingRuleId: null });

    expect(screen.getByText('No payment matching rule is linked to this loan.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Process history' })).not.toBeInTheDocument();
    expect(mockGetRule).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Create payment matching rule')).toBeInTheDocument();
    expect(within(dialog).getByText(/Current account/)).toBeInTheDocument();
    const payee = within(dialog).getByLabelText('Payee pattern');
    expect(payee).toHaveValue('*ING*');

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    });
    expect(mockCreateRule).toHaveBeenCalledWith('loan-1', { payeePattern: '*ING*', descriptionPattern: undefined });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('refuses a pattern without a wildcard before posting it', async () => {
    await renderPanel({ ...LOAN, paymentMatchingRuleId: null, institution: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    });
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Payee pattern'), { target: { value: 'ING' } });
    fireEvent.change(within(dialog).getByLabelText('Description pattern (optional)'), {
      target: { value: 'Hypotheek' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create rule' }));
    });
    expect(within(dialog).getByText('Enter a payee pattern that includes a * wildcard')).toBeInTheDocument();
    expect(within(dialog).getByText('A description pattern must include a * wildcard')).toBeInTheDocument();
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the server refusal when the rule cannot be created', async () => {
    mockCreateRule.mockRejectedValue(new Error('nope'));
    const onChanged = await renderPanel({ ...LOAN, paymentMatchingRuleId: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('nope')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('links the rule to its editor', async () => {
    await renderPanel();
    expect(mockGetRule).toHaveBeenCalledWith('rule-1');
    const link = screen.getByRole('link', { name: 'Mortgage payment - Home' });
    expect(link).toHaveAttribute('href', '/rules/rule-1');
    expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
  });

  it('says the rule failed to load instead of offering to create another', async () => {
    mockGetRule.mockRejectedValueOnce(new Error('boom'));
    await renderPanel();
    expect(screen.getByText('The payment matching rule could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Process history' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.getByRole('link', { name: 'Mortgage payment - Home' })).toBeInTheDocument();
  });

  it('warns while the bill still posts itself', async () => {
    mockGetSchedule.mockResolvedValue({ ...SCHEDULE, autoPost: true });
    await renderPanel();
    expect(screen.getByText('The scheduled payment still posts itself')).toBeInTheDocument();
  });

  it('does not warn when the bill does not post itself', async () => {
    await renderPanel();
    expect(screen.queryByText('The scheduled payment still posts itself')).not.toBeInTheDocument();
  });

  it('states the preconditions, dating the schedule start', async () => {
    await renderPanel();
    expect(screen.getByText(/opening balance must be the debt at the start/)).toBeInTheDocument();
    expect(screen.getByText(/when the scheduled payment starts/)).toBeInTheDocument();
  });

  it('asks for a scheduled payment first when the loan has none', async () => {
    await renderPanel({ ...LOAN, scheduledTransactionId: null, paymentMatchingRuleId: null });
    expect(screen.getByText(/Set up this loan's payments first/)).toBeInTheDocument();
    expect(mockGetSchedule).not.toHaveBeenCalled();
  });

  it('lists the settled installments with the server figures and a badge for a void one', async () => {
    await renderPanel(LOAN, {
      status: 'ready',
      rows: [
        settlement({ claimId: 'c-2', transactionId: 'tx-2', transactionStatus: 'VOID', principal: 833.33, interest: 498.61 }),
        settlement({ debtBefore: null }),
      ],
    });
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('Void')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/498\.61/)).toBeInTheDocument();
    expect(within(rows[2]).queryByText('Void')).not.toBeInTheDocument();
    // Unknown is said, never a zero.
    expect(within(rows[2]).getByText('Not recorded')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/transactions?targetTransactionId=tx-2');

    fireEvent.click(rows[2]);
    expect(mockPush).toHaveBeenCalledWith('/transactions?targetTransactionId=tx-1');
  });

  it('collapses and expands the settled installments from their title, and remembers the choice', async () => {
    await renderPanel(LOAN, { status: 'ready', rows: [settlement()] });
    const toggle = screen.getByRole('button', { name: /Settled installments/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('heading', { name: /Settled installments/ })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(localStorage.getItem(SETTLEMENTS_COLLAPSED_STORAGE_KEY)).toBe('true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(localStorage.getItem(SETTLEMENTS_COLLAPSED_STORAGE_KEY)).toBe('false');
  });

  it('opens folded when the reader folded the table away before', async () => {
    localStorage.setItem(SETTLEMENTS_COLLAPSED_STORAGE_KEY, 'true');
    await renderPanel(LOAN, { status: 'ready', rows: [settlement()] });
    expect(screen.getByRole('button', { name: /Settled installments/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the table when the stored choice is not a boolean', async () => {
    localStorage.setItem(SETTLEMENTS_COLLAPSED_STORAGE_KEY, '"yes"');
    await renderPanel(LOAN, { status: 'ready', rows: [settlement()] });
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('counts the settled installments in the title', async () => {
    await renderPanel(LOAN, {
      status: 'ready',
      rows: [settlement(), settlement({ claimId: 'c-2', transactionId: 'tx-2' })],
    });
    expect(screen.getByRole('button', { name: 'Settled installments (2)' })).toBeInTheDocument();
  });

  it('counts an empty list as zero', async () => {
    await renderPanel();
    expect(screen.getByRole('button', { name: 'Settled installments (0)' })).toBeInTheDocument();
  });

  it('shows no count when the settlements could not be loaded', async () => {
    await renderPanel(LOAN, { status: 'error' });
    expect(screen.getByRole('button', { name: 'Settled installments' })).toBeInTheDocument();
  });

  it('says when nothing has been settled yet', async () => {
    await renderPanel();
    expect(screen.getByText('No installments settled yet')).toBeInTheDocument();
  });

  it('renders a failed settlements request as an error with a retry, never as an empty list', async () => {
    const onChanged = await renderPanel(LOAN, { status: 'error' });
    expect(screen.getByText('The settled installments could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No installments settled yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('processes history page by page over the source account, oldest first, and invalidates the balance caches', async () => {
    mockPreviewRun
      .mockResolvedValueOnce(
        preview({
          matched: [matchedRow('tx-1', '2024-01-03'), matchedRow('tx-2', '2024-02-02')],
          skipped: [{ transactionId: 'tx-0', reason: 'no_installment_in_window' }],
          truncated: true,
          scannedThrough: '2024-06-30',
          fingerprint: 'fp-1',
        }),
      )
      .mockResolvedValueOnce(
        preview({
          matched: [matchedRow('tx-3', '2024-07-01')],
          // The row page 1 settled on its last date comes round again as a split.
          skipped: [{ transactionId: 'tx-2', reason: 'row_has_splits' }],
          truncated: false,
          scannedThrough: '2024-09-01',
          fingerprint: 'fp-2',
        }),
      );
    mockRun
      .mockResolvedValueOnce({ changed: 2, skipped: [{ transactionId: 'tx-0', reason: 'no_installment_in_window' }], historyId: 'h1' })
      .mockResolvedValueOnce({ changed: 1, skipped: [{ transactionId: 'tx-2', reason: 'row_has_splits' }], historyId: 'h2' });
    const onChanged = await renderPanel();

    await clickProcess();

    expect(mockPreviewRun).toHaveBeenNthCalledWith(1, 'rule-1', { accountIds: ['chq-1'], limit: 1000 });
    expect(mockRun).toHaveBeenNthCalledWith(1, 'rule-1', { accountIds: ['chq-1'], limit: 1000 }, 'fp-1');
    expect(mockPreviewRun).toHaveBeenNthCalledWith(2, 'rule-1', {
      accountIds: ['chq-1'],
      limit: 1000,
      startDate: '2024-06-30',
    });
    expect(mockRun).toHaveBeenNthCalledWith(
      2,
      'rule-1',
      { accountIds: ['chq-1'], limit: 1000, startDate: '2024-06-30' },
      'fp-2',
    );
    expect(mockPreviewRun).toHaveBeenCalledTimes(2);
    expect(mockInvalidateBalanceCaches).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText('3 installments were settled.')).toBeInTheDocument();
    // The skip reasons are listed; a row this run settled is not one of them.
    const skipped = screen.getByTestId('rule-run-skipped');
    expect(within(skipped).getByText(/1 transaction is left alone/)).toBeInTheDocument();
    expect(within(skipped).queryByText(/already split/)).not.toBeInTheDocument();
  });

  it('commits nothing for a page with nothing to change, and stops when it is not truncated', async () => {
    mockPreviewRun.mockResolvedValueOnce(
      preview({ skipped: [{ transactionId: 'tx-0', reason: 'installment_amount_shortfall' }] }),
    );
    await renderPanel();
    await clickProcess();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockPreviewRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No installments were settled.')).toBeInTheDocument();
    expect(screen.getByTestId('rule-run-skipped')).toBeInTheDocument();
  });

  it('previews a page again when its commit was refused PREVIEW_CHANGED', async () => {
    mockPreviewRun
      .mockResolvedValueOnce(preview({ matched: [matchedRow('tx-1', '2024-01-03')], fingerprint: 'old' }))
      .mockResolvedValueOnce(preview({ matched: [matchedRow('tx-1', '2024-01-03')], fingerprint: 'new' }));
    mockRun
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { errorCode: 'PREVIEW_CHANGED' } } })
      .mockResolvedValueOnce({ changed: 1, skipped: [], historyId: 'h' });
    await renderPanel();
    await clickProcess();
    expect(mockRun).toHaveBeenLastCalledWith('rule-1', { accountIds: ['chq-1'], limit: 1000 }, 'new');
    expect(screen.getByText('1 installment was settled.')).toBeInTheDocument();
  });

  it('stops with the date when a page cannot move past it', async () => {
    mockPreviewRun
      .mockResolvedValueOnce(preview({ truncated: true, scannedThrough: '2024-03-01' }))
      .mockResolvedValueOnce(preview({ truncated: true, scannedThrough: '2024-03-01' }));
    await renderPanel();
    await clickProcess();
    expect(mockPreviewRun).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Processing history could not continue')).toBeInTheDocument();
    expect(screen.getByText(/More than 1,000 transactions are dated/)).toBeInTheDocument();
  });

  it('renders a failed request as an error and still refreshes what earlier pages wrote', async () => {
    mockPreviewRun
      .mockResolvedValueOnce(
        preview({ matched: [matchedRow('tx-1', '2024-01-03')], truncated: true, scannedThrough: '2024-05-01' }),
      )
      .mockRejectedValueOnce(new Error('network down'));
    mockRun.mockResolvedValueOnce({ changed: 1, skipped: [], historyId: 'h' });
    const onChanged = await renderPanel();
    await clickProcess();
    expect(screen.getByText('Processing history stopped')).toBeInTheDocument();
    expect(screen.getByText('1 installment was settled.')).toBeInTheDocument();
    expect(mockInvalidateBalanceCaches).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
});
