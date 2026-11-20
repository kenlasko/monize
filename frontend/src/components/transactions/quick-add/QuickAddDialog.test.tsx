import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { __resetModalStateForTesting } from '@/components/ui/Modal';
import {
  QA_CHEQUING,
  qaField,
  qaMissing,
  qaPaymentReading,
  qaTransferReading,
} from '@/test/quick-add-fixtures';
import type { QuickAddInterpretation } from '@/types/quick-add';
import type { Account } from '@/types/account';
import { QuickAddDialog, type QuickAddDialogProps } from './QuickAddDialog';

const interpret = vi.fn();
vi.mock('@/lib/quick-add', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quick-add')>()),
  quickAddApi: { interpret: (...args: unknown[]) => interpret(...args) },
}));

const create = vi.fn();
const createTransfer = vi.fn();
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: {
    create: (...args: unknown[]) => create(...args),
    createTransfer: (...args: unknown[]) => createTransfer(...args),
  },
}));

const invalidateBalanceCaches = vi.fn();
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  invalidateBalanceCaches: () => invalidateBalanceCaches(),
}));

// The account picker draws institution logos; none here.
vi.mock('@/lib/institutions', () => ({ institutionsApi: { getAll: async () => [] } }));

vi.mock('@/hooks/useFinancialToday', () => ({ useFinancialToday: () => '2026-11-20' }));

const ACCOUNTS = [
  { id: QA_CHEQUING.id, name: 'Chequing', currencyCode: 'USD', accountType: 'CHEQUING', isClosed: false },
  { id: 'acc-sav', name: 'Savings', currencyCode: 'USD', accountType: 'SAVINGS', isClosed: false },
] as unknown as Account[];

function formModalStub() {
  return {
    close: vi.fn(),
    modalProps: { pushHistory: false, onBeforeClose: vi.fn() },
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null as (() => void) | null },
  };
}

async function renderDialog(props: Partial<QuickAddDialogProps> = {}) {
  const formModal = formModalStub();
  const onSaved = vi.fn();
  const onFullForm = vi.fn();
  await act(async () => {
    render(
      <QuickAddDialog
        formModal={formModal}
        accounts={ACCOUNTS}
        payees={[]}
        categories={[]}
        onSaved={onSaved}
        onFullForm={onFullForm}
        {...props}
      />,
    );
  });
  const input = screen.getByLabelText('Entry');
  return { formModal, onSaved, onFullForm, input };
}

/** Type a line and wait for its reading to be drawn. */
async function typeLine(input: HTMLElement, text: string, reading: QuickAddInterpretation) {
  interpret.mockResolvedValue(reading);
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
  await waitFor(() => expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ text })));
  await screen.findByRole('button', { name: /^Type: / });
}

async function pressEnter(input: HTMLElement, shiftKey = false) {
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', shiftKey });
  });
}

describe('QuickAddDialog', () => {
  beforeEach(() => {
    __resetModalStateForTesting();
    interpret.mockReset();
    create.mockReset().mockResolvedValue({ id: 'tx-new' });
    createTransfer.mockReset().mockResolvedValue({ fromTransaction: { id: 'f' }, toTransaction: { id: 't' } });
    invalidateBalanceCaches.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('is titled Quick Add, with a large box that keeps the keyboard out of the way', async () => {
    const { input } = await renderDialog();
    expect(screen.getByRole('dialog', { name: 'Quick Add' })).toBeInTheDocument();
    expect(input).toHaveAttribute('enterkeyhint', 'done');
    expect(input).toHaveAttribute('autocomplete', 'off');
    // The box takes the focus on open, so the phone keyboard (and its dictation) is up at once.
    await waitFor(() => expect(input).toHaveFocus());
    expect(interpret).not.toHaveBeenCalled();
  });

  it('shows each tier by its border and by a word in its name', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws groceries', qaPaymentReading());

    // Guessed: an outline chip with an amber dot.
    const kind = screen.getByRole('button', { name: 'Type: Payment, guessed' });
    expect(kind).toHaveAttribute('data-tier', 'guessed');
    expect(kind).toHaveClass('border-solid', 'bg-transparent');
    expect(kind.querySelector('.bg-amber-500')).not.toBeNull();
    // Typed: the solid primary-tinted chip, with no dot.
    const amount = screen.getByRole('button', { name: 'Amount: $84.37' });
    expect(amount).toHaveAttribute('data-tier', 'typed');
    expect(amount).toHaveClass('border-solid', 'bg-blue-100');
    expect(amount.querySelector('.bg-amber-500')).toBeNull();
    expect(screen.getByRole('button', { name: 'Payee: Loblaws' })).toHaveAttribute('data-tier', 'typed');
    expect(screen.getByRole('button', { name: 'Category: Food: Groceries' })).toHaveAttribute('data-tier', 'typed');
    // Assumed: the dashed grey border.
    const account = screen.getByRole('button', { name: 'Account: Chequing, not typed' });
    expect(account).toHaveAttribute('data-tier', 'assumed');
    expect(account).toHaveClass('border-dashed', 'border-gray-400');
    expect(screen.getByRole('button', { name: /^Date: .+, not typed$/ })).toHaveAttribute('data-tier', 'assumed');
  });

  it('draws the memo as a chip named by its field', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws see example.com/r/1', qaPaymentReading({ memo: 'see https://example.com/r/1' }));
    const memo = screen.getByTestId('quick-add-memo');
    expect(memo).toHaveTextContent('Description:see https://example.com/r/1');
    // The description the save stores: its address is drawn as the register draws it.
    expect(within(memo).getByRole('link', { name: 'https://example.com/r/1' })).toHaveAttribute(
      'href',
      'https://example.com/r/1',
    );
  });

  it('names what needs the reader: a missing value, several matches, a new payee', async () => {
    const { input } = await renderDialog();
    await typeLine(
      input,
      'visa corner cafe',
      qaPaymentReading({
        amount: qaMissing(),
        account: qaField({ id: 'v1', name: 'Visa', currencyCode: 'USD' }, 'typed', {
          ambiguous: true,
          alternatives: [{ id: 'v2', name: 'Visa Gold', currencyCode: 'USD' }],
        }),
        payee: qaField({ id: null, name: 'Corner Cafe' }),
        blockers: ['missingAmount', 'ambiguousAccount'],
      }),
    );
    const amount = screen.getByRole('button', { name: 'Amount: missing' });
    expect(amount).toHaveAttribute('data-tier', 'needs');
    // Needs you: an amber border and a short badge.
    expect(amount).toHaveClass('border-solid', 'border-amber-500');
    expect(amount).toHaveTextContent('Missing');
    expect(screen.getByRole('button', { name: 'Account: Visa, 2 matches' })).toHaveTextContent('2 matches');
    expect(screen.getByRole('button', { name: 'Payee: Corner Cafe, new payee' })).toHaveTextContent('New');
  });

  it('saves a payment as negative on Enter, drops the balances and closes', async () => {
    const { input, formModal, onSaved } = await renderDialog();
    await typeLine(input, '84.37 loblaws groceries', qaPaymentReading());
    await pressEnter(input);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-chq', amount: -84.37, currencyCode: 'USD', payeeId: 'payee-lob' }),
    );
    expect(invalidateBalanceCaches).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Transaction created');
    expect(formModal.close).toHaveBeenCalled();
  });

  it('saves a deposit as positive', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '+1200 payroll', qaPaymentReading({ kind: qaField('deposit'), amount: qaField(1200) }));
    await pressEnter(input);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1200 }));
  });

  it('saves a transfer through the transfer route, as its magnitude', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '500 chequing to savings', qaTransferReading());
    expect(screen.getByRole('button', { name: 'To Account: Savings' })).toBeInTheDocument();
    await pressEnter(input);
    expect(create).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: 'acc-chq', toAccountId: 'acc-sav', amount: 500 }),
    );
    expect(invalidateBalanceCaches).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Transfer created');
  });

  it('refuses Enter while a blocker stands, and says why', async () => {
    const { input, formModal } = await renderDialog();
    await typeLine(input, '20 € cafe', qaPaymentReading({ blockers: ['foreignCurrency'] }));
    await pressEnter(input);
    expect(create).not.toHaveBeenCalled();
    expect(formModal.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('quick-add-blockers')).toHaveTextContent(
      "The amount is in a currency other than the account's. Use Full Form to enter it.",
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves on Shift+Enter, clears the line and stays open for the next', async () => {
    const { input, formModal, onSaved } = await renderDialog();
    await typeLine(input, '84.37 loblaws groceries', qaPaymentReading());
    await pressEnter(input, true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalled();
    expect(formModal.close).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: /^Type: / })).not.toBeInTheDocument();
  });

  it('shows the balance line, and the day it moves for a future date', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws groceries', qaPaymentReading());
    expect(screen.getByTestId('quick-add-balance')).toHaveTextContent(
      'Chequing: $1,200.00 now, $1,115.63 after saving',
    );
    await typeLine(
      input,
      '84.37 loblaws dec 1',
      qaPaymentReading({
        balance: { accountId: 'acc-chq', currencyCode: 'USD', current: 1200, after: null, movesOn: '2026-12-01' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('quick-add-balance')).toHaveTextContent(/The balance moves on/),
    );
  });

  it("says what the reader's rules will change, as the assistant's cards do", async () => {
    const { input } = await renderDialog();
    await typeLine(
      input,
      '84.37 loblaws',
      qaPaymentReading({
        ruleEffects: {
          changes: { categoryId: 'cat-x', addTagIds: [], removeTagIds: [] },
          aiReviewRequests: [],
          labels: { categories: { 'cat-x': 'Food: Dining' }, payees: {}, tags: {}, rules: {} },
        },
      }),
    );
    const effects = screen.getByTestId('rule-effects');
    expect(effects).toHaveTextContent('Your rules will also:');
    expect(effects).toHaveTextContent('Set the category to Food: Dining');
  });

  it('pins a chip changed by hand, and keeps sending it as the reader types on', async () => {
    const { input } = await renderDialog();
    await typeLine(
      input,
      '84.37 tim',
      qaPaymentReading({
        payee: qaField({ id: 'payee-timber', name: 'Timberland' }, 'inferred', {
          alternatives: [{ id: 'payee-tim', name: 'Tim Hortons' }],
        }),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Payee: Timberland, guessed' }));
    });
    const editor = screen.getByRole('group', { name: 'Payee' });
    expect(within(editor).getByText('Other Matches')).toBeInTheDocument();
    const pinned = qaPaymentReading({ payee: qaField({ id: 'payee-tim', name: 'Tim Hortons' }, 'pinned') });
    interpret.mockResolvedValue(pinned);
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Tim Hortons' }));
    });
    await waitFor(() =>
      expect(interpret).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: '84.37 tim', pins: { payeeId: 'payee-tim' } }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'Payee: Tim Hortons' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Payee' })).not.toBeInTheDocument();

    await typeLine(input, '84.37 tim coffee', pinned);
    expect(interpret).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '84.37 tim coffee', pins: { payeeId: 'payee-tim' } }),
    );
  });

  it('pins the kind from the segmented control', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Type: Payment, guessed' }));
    });
    const editor = screen.getByRole('group', { name: 'Type' });
    expect(within(editor).getByRole('button', { name: 'Payment' })).toHaveAttribute('aria-pressed', 'true');
    interpret.mockResolvedValue(qaPaymentReading({ kind: qaField('deposit', 'pinned') }));
    await act(async () => {
      fireEvent.click(within(editor).getByRole('button', { name: 'Deposit' }));
    });
    await waitFor(() =>
      expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { kind: 'deposit' } })),
    );
  });

  it('pins an amount typed in its editor once Enter applies it', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Amount: $84.37' }));
    });
    const field = within(screen.getByRole('group', { name: 'Amount' })).getByLabelText('Amount');
    expect(field).toHaveFocus();
    await act(async () => {
      fireEvent.change(field, { target: { value: '90' } });
    });
    // Typing alone asks nothing: a pin is asked about at once, so each prefix would.
    expect(interpret).not.toHaveBeenLastCalledWith(expect.objectContaining({ pins: expect.anything() }));
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    await waitFor(() =>
      expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { amount: 90 } })),
    );
  });

  it('closes an open editor on Escape, and leaves the dialog open', async () => {
    const { input, formModal } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading());
    const chip = screen.getByRole('button', { name: 'Payee: Loblaws' });
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    expect(screen.queryByRole('group', { name: 'Payee' })).not.toBeInTheDocument();
    expect(formModal.close).not.toHaveBeenCalled();
    expect(chip).toHaveFocus();
  });

  it('shows a failed reading as failed, and asks again on Try Again', async () => {
    const { input } = await renderDialog();
    interpret.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      fireEvent.change(input, { target: { value: '84.37 loblaws' } });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to read the entry');
    expect(screen.queryByRole('button', { name: /^Type: / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    interpret.mockResolvedValue(qaPaymentReading());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    });
    await waitFor(() => expect(interpret).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Payee: Loblaws' })).toBeInTheDocument();
  });

  it('hands a blocked entry to the full form', async () => {
    const { input, onFullForm } = await renderDialog();
    await typeLine(input, '20 € cafe', qaPaymentReading({ blockers: ['foreignCurrency'] }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Full Form' }));
    });
    expect(onFullForm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'normal', accountId: 'acc-chq', amount: -84.37, payeeId: 'payee-lob' }),
    );
  });

  it('reads a line it was opened with, in the register account', async () => {
    interpret.mockResolvedValue(qaPaymentReading());
    await renderDialog({ initialText: '84.37 loblaws', contextAccountId: 'acc-chq' });
    await waitFor(() =>
      expect(interpret).toHaveBeenCalledWith({
        text: '84.37 loblaws',
        today: '2026-11-20',
        contextAccountId: 'acc-chq',
      }),
    );
    expect(screen.getByLabelText('Entry')).toHaveValue('84.37 loblaws');
  });

  it('reports the line as unsaved work', async () => {
    const { input, formModal } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading());
    expect(formModal.setFormDirty).toHaveBeenLastCalledWith(true);
  });
});
