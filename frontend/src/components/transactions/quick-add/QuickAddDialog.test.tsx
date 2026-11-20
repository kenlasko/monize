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

const findInactiveByName = vi.fn();
const createPayee = vi.fn();
const reactivatePayee = vi.fn();
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: {
    findInactiveByName: (...args: unknown[]) => findInactiveByName(...args),
    create: (...args: unknown[]) => createPayee(...args),
    reactivatePayee: (...args: unknown[]) => reactivatePayee(...args),
  },
}));

const rememberTransactionDate = vi.fn();
vi.mock('@/lib/lastTransactionDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lastTransactionDate')>()),
  rememberTransactionDate: (...args: unknown[]) => rememberTransactionDate(...args),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An HTTP refusal as axios rejects it. */
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

const fullFormButton = () => screen.getByRole('button', { name: 'Full Form' });

describe('QuickAddDialog', () => {
  beforeEach(() => {
    __resetModalStateForTesting();
    interpret.mockReset();
    create.mockReset().mockResolvedValue({ id: 'tx-new' });
    createTransfer.mockReset().mockResolvedValue({ fromTransaction: { id: 'f' }, toTransaction: { id: 't' } });
    invalidateBalanceCaches.mockReset();
    findInactiveByName.mockReset().mockResolvedValue(null);
    createPayee.mockReset().mockImplementation(async ({ name }: { name: string }) => ({ id: 'payee-new', name }));
    reactivatePayee.mockReset();
    rememberTransactionDate.mockReset();
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
    // A payee the reader has is linked, never made again.
    expect(createPayee).not.toHaveBeenCalled();
  });

  it('keeps a transfer\'s payee name as text, creating no payee record, as the full form does', async () => {
    const { input } = await renderDialog();
    await typeLine(
      input,
      '500 chequing to savings monthly top up',
      qaTransferReading({ payee: qaField({ id: null, name: 'monthly top up' }) }),
    );
    await pressEnter(input);
    await waitFor(() => expect(createTransfer).toHaveBeenCalledTimes(1));
    expect(findInactiveByName).not.toHaveBeenCalled();
    expect(createPayee).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ payeeId: null, payeeName: 'monthly top up' }),
    );
  });

  it('does not send a line the server counts as too long after NFKC, and says so', async () => {
    const { input } = await renderDialog();
    // 199 characters typed; the ellipsis becomes three after NFKC: 201.
    const line = `5 ${'x'.repeat(196)}\u2026`;
    expect(line).toHaveLength(199);
    await act(async () => {
      fireEvent.change(input, { target: { value: line } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(interpret).not.toHaveBeenCalled();
    expect(screen.getByText('This line is too long to read. Shorten it to continue.')).toBeInTheDocument();
    await pressEnter(input);
    expect(create).not.toHaveBeenCalled();
  });

  it('remembers the date the way New Transaction does, for a transaction and a transfer', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading({ date: qaField('2026-11-17') }));
    await pressEnter(input, true);
    expect(rememberTransactionDate).toHaveBeenCalledWith('monize-last-transaction-date', '2026-11-17');

    await typeLine(input, '500 chequing to savings', qaTransferReading({ date: qaField('2026-11-18') }));
    await pressEnter(input, true);
    expect(rememberTransactionDate).toHaveBeenLastCalledWith('monize-last-transaction-date', '2026-11-18');
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
    await typeLine(input, 'visa 84.37 loblaws', qaPaymentReading({ blockers: ['missingToAccount'] }));
    await act(async () => {
      fireEvent.click(fullFormButton());
    });
    expect(onFullForm).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'normal', accountId: 'acc-chq', amount: -84.37, payeeId: 'payee-lob' }),
    );
  });

  describe('a figure typed in another currency', () => {
    const euroReading = (currencyCode: string | null) =>
      qaPaymentReading({
        amount: qaField(20),
        payee: qaField({ id: 'payee-cafe', name: 'Cafe' }),
        category: qaMissing(),
        blockers: ['foreignCurrency'],
        balance: null,
        foreignAmount: { currencyCode, amount: 20 },
      });

    it('reads on its chip in its own currency and goes to the full form in it, never as the account\'s', async () => {
      const { input, onFullForm } = await renderDialog();
      await typeLine(input, '20 € cafe', euroReading('EUR'));
      expect(screen.getByRole('button', { name: 'Amount: €20.00 EUR' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /\$20\.00/ })).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      const draft = onFullForm.mock.calls[0][0];
      expect(draft).toMatchObject({
        mode: 'normal',
        accountId: 'acc-chq',
        originalCurrencyCode: 'EUR',
        originalAmount: -20,
        payeeId: 'payee-cafe',
      });
      expect(draft.amount).toBeUndefined();
    });

    it('reads in the typed currency and goes over as that currency alone while no account is known', async () => {
      const { input, onFullForm } = await renderDialog();
      await typeLine(
        input,
        '20 € cafe',
        qaPaymentReading({
          amount: qaField(20),
          account: qaMissing(),
          blockers: ['missingAccount'],
          balance: null,
          foreignAmount: { currencyCode: 'EUR', amount: 20 },
        }),
      );
      expect(screen.getByRole('button', { name: 'Amount: €20.00 EUR' })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      const draft = onFullForm.mock.calls[0][0];
      expect(draft).toMatchObject({ originalCurrencyCode: 'EUR', originalAmount: -20 });
      expect(draft.accountId).toBeUndefined();
      expect(draft.amount).toBeUndefined();
    });

    it('goes over without an amount when the typed symbol names no one currency', async () => {
      const { input, onFullForm } = await renderDialog();
      await typeLine(input, '20 kr cafe', euroReading(null));
      expect(screen.getByRole('button', { name: 'Amount: 20.00' })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      const draft = onFullForm.mock.calls[0][0];
      expect(draft.amount).toBeUndefined();
      expect(draft.originalAmount).toBeUndefined();
      expect(draft).toMatchObject({ accountId: 'acc-chq', payeeId: 'payee-cafe' });
    });
  });

  it('does not preselect an account that matched others equally in the full form', async () => {
    const { input, onFullForm } = await renderDialog();
    await typeLine(
      input,
      'visa 84.37 loblaws',
      qaPaymentReading({
        account: qaField({ id: 'v1', name: 'Visa', currencyCode: 'USD' }, 'typed', {
          ambiguous: true,
          alternatives: [{ id: 'v2', name: 'Visa Gold', currencyCode: 'USD' }],
        }),
        blockers: ['ambiguousAccount'],
      }),
    );
    await act(async () => {
      fireEvent.click(fullFormButton());
    });
    expect(onFullForm.mock.calls[0][0].accountId).toBeUndefined();
  });

  describe('a payee the line named that nobody has yet', () => {
    const newPayeeReading = () => qaPaymentReading({ payee: qaField({ id: null, name: 'Corner Cafe' }) });

    it('is created first, and the row is saved linked to it', async () => {
      const { input, formModal } = await renderDialog();
      await typeLine(input, '4.50 corner cafe', newPayeeReading());
      await pressEnter(input);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(findInactiveByName).toHaveBeenCalledWith('Corner Cafe');
      // The server runs its own background contact lookup on a payee made like this.
      expect(createPayee).toHaveBeenCalledWith({ name: 'Corner Cafe' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ payeeId: 'payee-new', payeeName: 'Corner Cafe' }));
      expect(toast.success).toHaveBeenCalledWith('Payee "Corner Cafe" created');
      expect(formModal.close).toHaveBeenCalled();
    });

    it('saves nothing when the payee cannot be created', async () => {
      createPayee.mockRejectedValue(new Error('boom'));
      const { input, formModal } = await renderDialog();
      await typeLine(input, '4.50 corner cafe', newPayeeReading());
      await pressEnter(input);
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(create).not.toHaveBeenCalled();
      expect(formModal.close).not.toHaveBeenCalled();
    });

    it('keeps the payee it made when the row is refused, so a second Save links it', async () => {
      create.mockRejectedValueOnce(new Error('boom'));
      const { input } = await renderDialog();
      await typeLine(input, '4.50 corner cafe', newPayeeReading());
      interpret.mockResolvedValue(qaPaymentReading({ payee: qaField({ id: 'payee-new', name: 'Corner Cafe' }, 'pinned') }));
      await pressEnter(input);
      await waitFor(() =>
        expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { payeeId: 'payee-new' } })),
      );
      await screen.findByRole('button', { name: 'Payee: Corner Cafe' });
      await pressEnter(input);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(createPayee).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ payeeId: 'payee-new' }));
    });

    describe('when an inactive payee has the name', () => {
      const inactive = { id: 'payee-old', name: 'Corner Cafe', isActive: false };
      beforeEach(() => {
        findInactiveByName.mockResolvedValue(inactive);
      });

      async function saveAndAsk() {
        const rendered = await renderDialog();
        await typeLine(rendered.input, '4.50 corner cafe', newPayeeReading());
        await pressEnter(rendered.input);
        expect(await screen.findByRole('dialog', { name: 'Reactivate Payee' })).toBeInTheDocument();
        expect(createPayee).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        return rendered;
      }

      it('offers it back, and saves the row linked to it once reactivated', async () => {
        reactivatePayee.mockResolvedValue({ ...inactive, isActive: true });
        const { formModal } = await saveAndAsk();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
        });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(reactivatePayee).toHaveBeenCalledWith('payee-old');
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ payeeId: 'payee-old', payeeName: 'Corner Cafe' }));
        expect(formModal.close).toHaveBeenCalled();
      });

      it('saves the name as text with no payee on Keep Inactive, as the full form does', async () => {
        await saveAndAsk();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'No, Keep Inactive' }));
        });
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ payeeId: null, payeeName: 'Corner Cafe' }));
        expect(reactivatePayee).not.toHaveBeenCalled();
      });

      it('saves nothing when the question is closed unanswered', async () => {
        const { formModal } = await saveAndAsk();
        const question = screen.getByRole('dialog', { name: 'Reactivate Payee' });
        const reactivateButton = within(question).getByRole('button', { name: 'Reactivate' });
        await act(async () => {
          reactivateButton.focus();
        });
        await act(async () => {
          fireEvent.keyDown(reactivateButton, { key: 'Escape' });
        });
        await waitFor(() =>
          expect(screen.queryByRole('dialog', { name: 'Reactivate Payee' })).not.toBeInTheDocument(),
        );
        expect(create).not.toHaveBeenCalled();
        expect(formModal.close).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      });
    });
  });

  describe('an action taken while the line is still being read', () => {
    it('saves on Enter once the reading arrives, when nothing blocks it', async () => {
      const { input } = await renderDialog();
      const answer = deferred<QuickAddInterpretation>();
      interpret.mockReturnValueOnce(answer.promise);
      await act(async () => {
        fireEvent.change(input, { target: { value: '84.37 loblaws groceries' } });
      });
      await pressEnter(input);
      expect(create).not.toHaveBeenCalled();
      await waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      await act(async () => answer.resolve(qaPaymentReading()));
      await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: -84.37 })));
    });

    it('shows the blockers instead when the arriving reading has some', async () => {
      const { input, formModal } = await renderDialog();
      const answer = deferred<QuickAddInterpretation>();
      interpret.mockReturnValueOnce(answer.promise);
      await act(async () => {
        fireEvent.change(input, { target: { value: '84.37' } });
      });
      await pressEnter(input, true);
      await waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      await act(async () => answer.resolve(qaPaymentReading({ account: qaMissing(), blockers: ['missingAccount'] })));
      expect(await screen.findByTestId('quick-add-blockers')).toHaveTextContent('Choose an account.');
      expect(create).not.toHaveBeenCalled();
      expect(formModal.close).not.toHaveBeenCalled();
    });

    it('drops an Enter made before the reader changed the line again', async () => {
      const { input } = await renderDialog();
      const first = deferred<QuickAddInterpretation>();
      interpret.mockReturnValueOnce(first.promise);
      await act(async () => {
        fireEvent.change(input, { target: { value: '84.37 loblaws' } });
      });
      await pressEnter(input);
      await waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      await typeLine(input, '84.37 loblaws coffee', qaPaymentReading());
      await act(async () => first.resolve(qaPaymentReading()));
      expect(create).not.toHaveBeenCalled();
    });

    it('hands the line to Full Form after an amount editor blurs, with what the reading settled', async () => {
      // In a browser the press on Full Form blurs the open amount editor
      // first, which pins its figure and sends the line to be read again.
      const { input, onFullForm } = await renderDialog();
      await typeLine(input, '84.37 loblaws groceries', qaPaymentReading());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Amount: $84.37' }));
      });
      const field = within(screen.getByRole('group', { name: 'Amount' })).getByLabelText('Amount');
      await act(async () => {
        fireEvent.change(field, { target: { value: '90' } });
      });
      const answer = deferred<QuickAddInterpretation>();
      interpret.mockReturnValueOnce(answer.promise);
      await act(async () => {
        fireEvent.blur(field);
      });
      await waitFor(() =>
        expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { amount: 90 } })),
      );
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      expect(onFullForm).not.toHaveBeenCalled();
      await act(async () => answer.resolve(qaPaymentReading({ amount: qaField(90, 'pinned') })));
      await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
      expect(onFullForm).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'normal',
          accountId: 'acc-chq',
          amount: -90,
          payeeId: 'payee-lob',
          categoryId: 'cat-groc',
          date: '2026-11-20',
        }),
      );
    });

    it('hands the typed line over as the description when the reading fails', async () => {
      const { input, onFullForm } = await renderDialog();
      const answer = deferred<QuickAddInterpretation>();
      interpret.mockReturnValueOnce(answer.promise);
      await act(async () => {
        fireEvent.change(input, { target: { value: '84.37 loblaws groceries' } });
      });
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      await waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      expect(onFullForm).not.toHaveBeenCalled();
      await act(async () => answer.reject(new Error('down')));
      await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
      expect(onFullForm).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'normal', description: '84.37 loblaws groceries' }),
      );
    });
  });

  it('hands the typed line over as the description from a failed reading', async () => {
    const { input, onFullForm } = await renderDialog();
    interpret.mockRejectedValueOnce(new Error('down'));
    await act(async () => {
      fireEvent.change(input, { target: { value: '84.37 loblaws' } });
    });
    await screen.findByRole('alert');
    await act(async () => {
      fireEvent.click(fullFormButton());
    });
    expect(onFullForm).toHaveBeenCalledWith({ mode: 'normal', description: '84.37 loblaws' });
  });

  it('keeps an open amount editor on the reading as the line is retyped, and pins nothing untouched', async () => {
    const { input } = await renderDialog();
    await typeLine(input, '84.37 loblaws', qaPaymentReading());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Amount: $84.37' }));
    });
    const field = within(screen.getByRole('group', { name: 'Amount' })).getByLabelText('Amount');
    // Back to the line, leaving the editor open and untouched.
    await act(async () => {
      fireEvent.blur(field);
    });
    interpret.mockResolvedValue(qaPaymentReading({ amount: qaField(50) }));
    await act(async () => {
      fireEvent.change(input, { target: { value: '50 loblaws' } });
    });
    expect(await screen.findByRole('button', { name: 'Amount: $50.00' })).toBeInTheDocument();
    // CurrencyInput re-syncs its text in an effect after the new figure commits.
    await waitFor(() => expect(field).toHaveValue('50.00'));
    // Through the editor and out again, typing nothing.
    await act(async () => {
      fireEvent.focus(field);
    });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(interpret).not.toHaveBeenCalledWith(expect.objectContaining({ pins: expect.anything() }));
  });

  describe('a pin the server refuses', () => {
    async function refusePin() {
      const rendered = await renderDialog();
      await typeLine(
        rendered.input,
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
      // Tim Hortons was deleted elsewhere since the reading listed it.
      interpret.mockRejectedValue(httpError(404));
      await act(async () => {
        fireEvent.click(within(screen.getByRole('group', { name: 'Payee' })).getByRole('button', { name: 'Tim Hortons' }));
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Something you chose is no longer available');
      return rendered;
    }

    it('is reported apart from a failed request, and Clear Changes reads the line without it', async () => {
      await refusePin();
      expect(screen.queryByText('Failed to read the entry')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
      interpret.mockReset().mockResolvedValue(qaPaymentReading());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear Changes' }));
      });
      await waitFor(() => expect(interpret).toHaveBeenCalledWith({ text: '84.37 tim', today: '2026-11-20' }));
      expect(await screen.findByRole('button', { name: 'Payee: Loblaws' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('is not handed to the full form', async () => {
      const { onFullForm } = await refusePin();
      await act(async () => {
        fireEvent.click(fullFormButton());
      });
      expect(onFullForm).toHaveBeenCalledWith({ mode: 'normal', description: '84.37 tim' });
    });
  });

  describe('a payee or category the reader clears', () => {
    it('reads as their own choice of none, is never guessed again, and saves as none', async () => {
      const { input } = await renderDialog();
      await typeLine(input, '84.37 loblaws', qaPaymentReading({ payee: qaField({ id: 'payee-lob', name: 'Loblaws' }, 'inferred') }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Payee: Loblaws, guessed' }));
      });
      const editor = screen.getByRole('group', { name: 'Payee' });
      // An older server's empty answer: the reader's own pins say it is theirs.
      interpret.mockResolvedValue(qaPaymentReading({ payee: qaMissing() }));
      await act(async () => {
        fireEvent.mouseDown(editor.querySelector('button[tabindex="-1"]')!);
      });
      await waitFor(() =>
        expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { clear: ['payee'] } })),
      );
      const chip = await screen.findByRole('button', { name: 'Payee: No payee' });
      expect(chip).toHaveAttribute('data-tier', 'typed');
      expect(chip).not.toHaveTextContent('Missing');

      await typeLine(input, '84.37 loblaws coffee', qaPaymentReading({ payee: qaMissing('pinned') }));
      expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { clear: ['payee'] } }));
      await pressEnter(input);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ payeeId: null, payeeName: null }));
    });

    it('clears a category the same way', async () => {
      const { input } = await renderDialog();
      await typeLine(input, '84.37 loblaws', qaPaymentReading({ category: qaField({ id: 'cat-groc', name: 'Food: Groceries' }, 'inferred') }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Category: Food: Groceries, guessed' }));
      });
      const editor = screen.getByRole('group', { name: 'Category' });
      interpret.mockResolvedValue(qaPaymentReading({ category: qaMissing('pinned') }));
      await act(async () => {
        fireEvent.mouseDown(editor.querySelector('button[tabindex="-1"]')!);
      });
      await waitFor(() =>
        expect(interpret).toHaveBeenLastCalledWith(expect.objectContaining({ pins: { clear: ['category'] } })),
      );
      expect(await screen.findByRole('button', { name: 'Category: No category' })).toHaveAttribute('data-tier', 'typed');
      await pressEnter(input);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ categoryId: null }));
    });
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
