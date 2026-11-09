import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { __resetModalStateForTesting } from '@/components/ui/Modal';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/dashboard',
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

import { CommandPalette } from './CommandPalette';
import { useAuthStore } from '@/store/authStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useHelpStore } from '@/store/helpStore';

const hydro = {
  id: 'p1',
  name: 'Hydro One',
  transactionCount: 38,
  defaultCategory: { name: 'Utilities' },
  defaultCategoryId: 'c1',
  hasLogo: false,
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
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useCommandPaletteStore.getState().openPalette();
  useAuthStore.setState({ actingAsUserId: null, delegateSections: null, delegateCapabilities: null });
  getAccounts.mockResolvedValue([]);
  getPayees.mockResolvedValue([hydro]);
  getCategories.mockResolvedValue([]);
  getBills.mockResolvedValue([]);
  getSecurities.mockResolvedValue([]);
  getTransactions.mockResolvedValue({ data: [] });
  searchHelp.mockResolvedValue({ results: [] });
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

  it('asks for a prefilled transaction on Alt+N without typing into the box', async () => {
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.keyDown(box, { key: 'n', code: 'KeyN', altKey: true });
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
    fireEvent.mouseDown(row!);
    expect(push).toHaveBeenCalledWith('/transactions?targetTransactionId=t1');
  });

  it('hands a guide hit to the help panel', async () => {
    searchHelp.mockResolvedValue({ results: [{ page: 'bills', section: 'x', heading: 'Hydro bills', pageTitle: 'Bills' }] });
    const openAt = vi.spyOn(useHelpStore.getState(), 'openAt');
    const box = await openPalette();
    await type(box, 'hydro');
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Hydro bills/ }));
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

  it('is named for assistive technology without drawing a heading', async () => {
    await openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Command palette' })).toHaveClass('sr-only');
  });
});
