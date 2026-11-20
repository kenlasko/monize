import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { __resetModalStateForTesting } from '@/components/ui/Modal';

const push = vi.fn();
const mockPathname = vi.hoisted(() => ({ value: '/dashboard' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => mockPathname.value,
}));

const getAccounts = vi.fn();
const getPayees = vi.fn();
const getCategories = vi.fn();
const getBills = vi.fn();
const getSecurities = vi.fn();
const getTransactions = vi.fn();
const searchHelp = vi.fn();

vi.mock('@/lib/accounts', () => ({ accountsApi: { getAll: () => getAccounts() } }));
vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: () => getPayees() },
  payeeLogoUrl: (id: string) => `/logo/${id}`,
}));
vi.mock('@/lib/categories', () => ({ categoriesApi: { getAll: () => getCategories() } }));
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getAll: () => getBills() },
}));
vi.mock('@/lib/investments', () => ({ investmentsApi: { getSecurities: () => getSecurities() } }));
vi.mock('@/lib/custom-reports', () => ({ customReportsApi: { getAll: async () => [] } }));
vi.mock('@/lib/investment-reports', () => ({ investmentReportsApi: { getAll: async () => [] } }));
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { getAll: (params: unknown) => getTransactions(params) },
}));
vi.mock('@/lib/help', () => ({ helpApi: { search: (q: string) => searchHelp(q) } }));
const interpret = vi.fn();
vi.mock('@/lib/quick-add', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quick-add')>()),
  quickAddApi: { interpret: (...args: unknown[]) => interpret(...args) },
}));
vi.mock('@/hooks/useFinancialToday', () => ({ useFinancialToday: () => '2026-11-20' }));

import { CommandPalette } from './CommandPalette';
import { useAuthStore } from '@/store/authStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useHelpStore } from '@/store/helpStore';
import { qaField, qaMissing, qaPaymentReading, qaTransferReading } from '@/test/quick-add-fixtures';
import type { QuickAddInterpretation } from '@/types/quick-add';

const hydro = {
  id: 'p1',
  name: 'Hydro One',
  transactionCount: 38,
  defaultCategory: { name: 'Utilities' },
  defaultCategoryId: 'c1',
  hasLogo: false,
  isActive: true,
};

async function openPalette() {
  await act(async () => {
    render(<CommandPalette />);
  });
  return screen.getByRole('combobox', { name: 'Command palette' });
}

async function type(box: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(box, { target: { value } });
  });
}

const activeLabel = () =>
  screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.textContent;

beforeEach(() => {
  __resetModalStateForTesting();
  push.mockReset();
  mockPathname.value = '/dashboard';
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useCommandPaletteStore.getState().openPalette();
  useHelpStore.setState({ guideAvailable: null });
  useAuthStore.setState({ actingAsUserId: null, delegateSections: null, delegateCapabilities: null });
  getAccounts.mockResolvedValue([]);
  getPayees.mockResolvedValue([hydro]);
  getCategories.mockResolvedValue([]);
  getBills.mockResolvedValue([]);
  getSecurities.mockResolvedValue([]);
  getTransactions.mockResolvedValue({ data: [] });
  searchHelp.mockResolvedValue({ results: [] });
  interpret.mockReset().mockResolvedValue(null);
});

describe('CommandPalette', () => {
  it('lists pages and actions before anything is typed', async () => {
    await openPalette();
    expect(screen.getByRole('option', { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /New transaction/ })).toBeInTheDocument();
  });

  it('finds a payee and shows its count and category', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    expect(screen.getByRole('option', { name: /Hydro One.*38 transactions · Utilities/ })).toBeInTheDocument();
  });

  it('opens the payee on Enter and closes', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/payees/p1');
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('moves with the arrows, wrapping at both ends', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    const count = screen.getAllByRole('option').length;
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(activeLabel()).toBe(screen.getAllByRole('option')[count - 1].textContent);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(activeLabel()).toBe(screen.getAllByRole('option')[0].textContent);
  });

  it('jumps to the actions on Tab', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(activeLabel()).toMatch(/New transaction for Hydro One/);
  });

  it('asks for a prefilled transaction on Ctrl+Enter', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(useCommandPaletteStore.getState().newTransactionRequest).toEqual({
      payee: { id: 'p1', name: 'Hydro One', defaultCategoryId: 'c1' },
    });
    expect(push).toHaveBeenCalledWith('/transactions');
  });

  it('adds transactions and guide hits once the server answers', async () => {
    getTransactions.mockResolvedValue({
      data: [{ id: 't1', payeeName: 'Hydro One', transactionDate: '2026-10-12', amount: -118.4, currencyCode: 'CAD', account: { name: 'Chequing' } }],
    });
    searchHelp.mockResolvedValue({ results: [{ page: 'bills', section: 'hydro', heading: 'Hydro bills', pageTitle: 'Bills' }] });
    const box = await openPalette();
    await type(box, 'hydro');
    await waitFor(() => expect(screen.getByRole('option', { name: /Hydro bills/ })).toBeInTheDocument());

    const row = screen.getAllByRole('option').find((o) => /Chequing/.test(o.textContent ?? ''));
    fireEvent.click(row!);
    expect(push).toHaveBeenCalledWith('/transactions?accountStatus=all&targetTransactionId=t1');
  });

  it('hands a guide hit to the help panel', async () => {
    searchHelp.mockResolvedValue({ results: [{ page: 'bills', section: 'x', heading: 'Hydro bills', pageTitle: 'Bills' }] });
    const openAt = vi.spyOn(useHelpStore.getState(), 'openAt');
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.click(await screen.findByRole('option', { name: /Hydro bills/ }));
    expect(openAt).toHaveBeenCalledWith({ page: 'bills', section: 'x' });
  });

  it('does not ask the server about a single letter', async () => {
    const box = await openPalette();
    await type(box, 'h');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('warns when a source fails, and keeps the others', async () => {
    getAccounts.mockRejectedValue(new Error('boom'));
    const box = await openPalette();
    await type(box, 'hydro');
    expect(screen.getByRole('alert')).toHaveTextContent('Some results could not be loaded.');
    expect(screen.getByRole('option', { name: /Hydro One.*38 transactions/ })).toBeInTheDocument();
  });

  it('treats a delegate refusal as nothing to show, not a failure', async () => {
    getPayees.mockRejectedValue({ response: { status: 403 } });
    await openPalette();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads no source a delegate cannot reach', async () => {
    useAuthStore.setState({
      actingAsUserId: 'owner',
      delegateSections: { transactions: true } as never,
      delegateCapabilities: null,
    });
    await openPalette();
    expect(getAccounts).not.toHaveBeenCalled();
    expect(getPayees).not.toHaveBeenCalled();
    expect(getBills).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: /^Accounts/ })).not.toBeInTheDocument();
  });

  it('lists built-in reports under their translated names', async () => {
    const box = await openPalette();
    await type(box, 'spending by payee');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/reports/spending-by-payee');
  });

  it('keeps focus in the box on Shift+Tab', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    box.focus();
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(box);
    expect(activeLabel()).toBe(screen.getAllByRole('option')[0].textContent);
  });

  it('still closes on Escape', async () => {
    const box = await openPalette();
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it('draws a route that is both a menu entry and a Settings link once', async () => {
    const box = await openPalette();
    await type(box, 'email receipts');
    expect(screen.getAllByRole('option', { name: /Email Receipts/ })).toHaveLength(1);
  });

  it('leaves Enter to an input method that is composing', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(push).not.toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('runs a row on a click, and not on a right-button press', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    const row = screen.getByRole('option', { name: /38 transactions/ });
    fireEvent.mouseDown(row, { button: 2 });
    fireEvent.contextMenu(row);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith('/payees/p1');
  });

  it('does not push over the form when already on Transactions', async () => {
    mockPathname.value = '/transactions';
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(useCommandPaletteStore.getState().newTransactionRequest).not.toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the balance the Accounts page shows, and none for a brokerage', async () => {
    getAccounts.mockResolvedValue([
      { id: 'a1', name: 'Hydro Savings', institution: null, currentBalance: 100, futureTransactionsSum: -40, currencyCode: 'CAD', accountSubType: null },
      { id: 'a2', name: 'Hydro Brokerage', institution: null, currentBalance: 0, currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
    ]);
    const box = await openPalette();
    await type(box, 'hydro');
    expect(screen.getByRole('option', { name: /Hydro Savings/ })).toHaveTextContent('$60.00');
    expect(screen.getByRole('option', { name: /Hydro Brokerage/ }).textContent).not.toMatch(/\$/);
  });

  it('shows no count for a payee whose count is unknown', async () => {
    getPayees.mockResolvedValue([{ ...hydro, transactionCount: undefined }]);
    const box = await openPalette();
    await type(box, 'hydro');
    const row = screen.getAllByRole('option')[0];
    expect(row).toHaveTextContent('Utilities');
    expect(row.textContent).not.toMatch(/transactions/);
  });

  it('leaves AltGr+N and Option+N to the keyboard layout', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    expect(fireEvent.keyDown(box, { key: 'ń', code: 'KeyN', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'ń', code: 'KeyN', altKey: true, ctrlKey: true })).toBe(true);
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it('runs the shortcut with Cmd+Enter too', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(useCommandPaletteStore.getState().newTransactionRequest).not.toBeNull();
  });

  it('opens Bills & Deposits at the bill it found, for the page to highlight', async () => {
    getBills.mockResolvedValue([
      {
        id: 'b1',
        name: 'Water Bill',
        isActive: true,
        amount: -40,
        currencyCode: 'CAD',
        nextDueDate: '2099-01-01',
        accountId: 'a1',
      },
    ]);
    const box = await openPalette();
    await type(box, 'water');
    fireEvent.click(screen.getByRole('option', { name: /Water Bill/ }));
    expect(push).toHaveBeenCalledWith('/bills?highlight=b1');
  });

  it('offers an inactive payee its history but no new entry', async () => {
    getPayees.mockResolvedValue([{ ...hydro, isActive: false }]);
    const box = await openPalette();
    await type(box, 'hydro');
    expect(screen.getByRole('option', { name: /38 transactions/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /New transaction for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /All transactions for/ })).toBeInTheDocument();
  });

  it('starts a new entry from the best active payee when the best match is inactive', async () => {
    getPayees.mockResolvedValue([
      { ...hydro, isActive: false },
      { ...hydro, id: 'p2', name: 'Hydro Quebec', isActive: true },
    ]);
    const box = await openPalette();
    await type(box, 'hydro');
    expect(screen.getByRole('option', { name: /New transaction for Hydro Quebec/ })).toBeInTheDocument();
  });

  it('shows all of a payee\'s transactions whatever Show Accounts is set to', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.click(screen.getByRole('option', { name: /All transactions for/ }));
    expect(push).toHaveBeenCalledWith('/transactions?payeeId=p1&accountStatus=all');
  });

  it.each(['heading', 'footer'])('keeps focus in the box when the %s is pressed', async (where) => {
    await openPalette();
    const target = where === 'heading' ? screen.getByText('Go to') : screen.getByText('navigate');
    expect(fireEvent.mouseDown(target)).toBe(false);
  });

  it('leaves a press in the box itself alone, so the caret can move', async () => {
    const box = await openPalette();
    expect(fireEvent.mouseDown(box)).toBe(true);
  });

  it('scrolls for a key press, and not for a re-render or a hover', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const box = await openPalette();
    await type(box, 'hydro');
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.mouseMove(screen.getAllByRole('option')[1]);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('marks an accent-insensitive match', async () => {
    getPayees.mockResolvedValue([{ ...hydro, name: 'Café Rouge' }]);
    const box = await openPalette();
    await type(box, 'cafe');
    expect(screen.getAllByText('Café')[0].tagName).toBe('MARK');
  });

  it('reports a failed help search once the guide is known to be bundled', async () => {
    useHelpStore.setState({ guideAvailable: true });
    searchHelp.mockRejectedValue(new Error('down'));
    const box = await openPalette();
    await type(box, 'hydro');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('stays quiet about help on a server without the guide', async () => {
    useHelpStore.setState({ guideAvailable: false });
    searchHelp.mockRejectedValue(new Error('no guide'));
    const box = await openPalette();
    await type(box, 'hydro');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is named for assistive technology without drawing a heading', async () => {
    await openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Command palette' })).toHaveClass('sr-only');
  });

  describe('the Quick add row', () => {
    const quickAddRow = () => screen.queryByRole('option', { name: /^Quick add:/ });

    it('reads a line with an amount and offers it first among the actions', async () => {
      interpret.mockResolvedValue(qaPaymentReading());
      const box = await openPalette();
      await type(box, '84.37 loblaws groceries');
      expect(await screen.findByRole('option', { name: /Quick add: \$84\.37 Loblaws, Food: Groceries/ })).toBeInTheDocument();
      expect(interpret).toHaveBeenCalledWith({ text: '84.37 loblaws groceries', today: '2026-11-20' });
      fireEvent.keyDown(box, { key: 'Tab' });
      expect(activeLabel()).toMatch(/^Quick add:/);
    });

    it('leaves out what the line did not settle', async () => {
      interpret.mockResolvedValue(
        qaPaymentReading({ amount: qaField(12.5), payee: qaMissing(), category: qaMissing() }),
      );
      const box = await openPalette();
      await type(box, '12.50');
      await waitFor(() => expect(quickAddRow()).toBeInTheDocument());
      // The row is the only result here, so it is the active one and carries ↵.
      expect(quickAddRow()?.textContent).toMatch(/^Quick add: \$12\.50(↵)?$/);
    });

    it('reads a transfer as from and to', async () => {
      interpret.mockResolvedValue(qaTransferReading());
      const box = await openPalette();
      await type(box, '500 chequing to savings');
      expect(await screen.findByRole('option', { name: /Quick add: \$500\.00 Chequing to Savings/ })).toBeInTheDocument();
    });

    it('offers nothing for a line without an amount, and does not ask', async () => {
      const box = await openPalette();
      await type(box, 'hydro');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      expect(interpret).not.toHaveBeenCalled();
      expect(quickAddRow()).not.toBeInTheDocument();
    });

    it('offers nothing when the reading found no amount', async () => {
      interpret.mockResolvedValue(qaPaymentReading({ amount: qaMissing() }));
      const box = await openPalette();
      await type(box, '2024 report');
      await waitFor(() => expect(interpret).toHaveBeenCalled());
      await act(async () => {});
      expect(quickAddRow()).not.toBeInTheDocument();
    });

    it('asks nothing for an acting delegate', async () => {
      useAuthStore.setState({
        actingAsUserId: 'owner',
        delegateSections: { transactions: true } as never,
        delegateCapabilities: null,
      });
      const box = await openPalette();
      await type(box, '84.37 loblaws');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      expect(interpret).not.toHaveBeenCalled();
      expect(quickAddRow()).not.toBeInTheDocument();
    });

    it('asks nothing when the register cannot be reached', async () => {
      useAuthStore.setState({
        actingAsUserId: 'owner',
        delegateSections: { bills: true } as never,
        delegateCapabilities: null,
      });
      const box = await openPalette();
      await type(box, '84.37 loblaws');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      expect(interpret).not.toHaveBeenCalled();
    });

    it('adds no row and reports nothing when the reading fails', async () => {
      interpret.mockRejectedValue(new Error('down'));
      const box = await openPalette();
      await type(box, '84.37 loblaws');
      await waitFor(() => expect(interpret).toHaveBeenCalled());
      await act(async () => {});
      expect(quickAddRow()).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // The search the line also is still offered.
      expect(screen.getByRole('option', { name: /Search transactions for/ })).toBeInTheDocument();
    });

    it('never draws an earlier line\'s reading under a newer one', async () => {
      let resolveFirst!: (value: QuickAddInterpretation) => void;
      interpret.mockImplementationOnce(
        () => new Promise<QuickAddInterpretation>((resolve) => {
          resolveFirst = resolve;
        }),
      );
      const box = await openPalette();
      await type(box, '84.37 loblaws');
      await waitFor(() => expect(interpret).toHaveBeenCalledTimes(1));
      interpret.mockResolvedValueOnce(qaPaymentReading({ amount: qaField(12), payee: qaField({ id: 't', name: 'Tim Hortons' }), category: qaMissing() }));
      await type(box, '12 tim');
      expect(await screen.findByRole('option', { name: /Quick add: \$12\.00 Tim Hortons/ })).toBeInTheDocument();
      await act(async () => {
        resolveFirst(qaPaymentReading());
      });
      expect(screen.queryByRole('option', { name: /Loblaws/ })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Quick add: \$12\.00 Tim Hortons/ })).toBeInTheDocument();
    });

    it('opens Quick Add on the register with the line', async () => {
      interpret.mockResolvedValue(qaPaymentReading());
      const box = await openPalette();
      await type(box, '84.37 loblaws groceries');
      fireEvent.click(await screen.findByRole('option', { name: /^Quick add:/ }));
      expect(useCommandPaletteStore.getState().quickAddRequest).toEqual({ text: '84.37 loblaws groceries' });
      expect(push).toHaveBeenCalledWith('/transactions');
      expect(useCommandPaletteStore.getState().open).toBe(false);
    });
  });
});
