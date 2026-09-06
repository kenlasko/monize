import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountList } from './AccountList';
import { Account } from '@/types/account';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each account is a wrapped card in a single `<td>`
 * -- which is how the type and status this table hides below `sm`/`md` get
 * back on screen -- while Compact and Dense keep the tier table, and so does
 * every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the
 * branch in JS rather than with CSS variants.
 */

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    close: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    setDelegateFavourite: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const PHONE_QUERY = '(max-width: 639px)';

const originalMatchMedia = window.matchMedia;

/** Answer `true` only for the phone query `useIsMobile` asks. */
function setPhoneViewport(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Main Chequing',
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    institutionId: null,
    openingBalance: 1000,
    currentBalance: 1500,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    favouriteSortOrder: 0,
    excludeFromNetWorth: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    interestBookingMode: 'AUTO',
    overpaymentCategoryId: null,
    overpaymentMemo: null,
    overpaymentPayeeId: null,
    fxFeePercent: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    linkedLoanAccountId: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    statementDueDay: null,
    statementSettlementDay: null,
    canDelete: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const convertToDefault = (n: number) => n;

function renderList(accounts: Account[]) {
  return render(
    <AccountList
      accounts={accounts}
      onEdit={vi.fn()}
      onRefresh={vi.fn()}
      defaultCurrency="CAD"
      convertToDefault={convertToDefault}
    />,
  );
}

/** Account rows: every body row except the group headers. */
function accountRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr')).filter(
    (row) => !row.hasAttribute('aria-expanded'),
  ) as HTMLTableRowElement[];
}

function groupRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(
    container.querySelectorAll<HTMLTableRowElement>('tbody tr[aria-expanded]'),
  );
}

describe('the accounts list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each account as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([
      createAccount({ name: 'Main Chequing', currentBalance: 1500 }),
    ]);

    const rows = accountRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // More of the account than a phone-width tier table shows, all in the one
    // row: the name, the balance, and the type and status this table hides
    // below `sm` and `md`.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Main Chequing');
    expect(text).toContain('$1500.00');
    expect(text).toContain('Chequing');
    expect(text).toContain('Active');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('replaces the column header with a slim sort header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([createAccount()]);

    const head = container.querySelector('thead');
    expect(head).toBeTruthy();
    expect(head!.querySelectorAll('th')).toHaveLength(1);
    // Every sortable field survives as a button. Fewer would leave a list
    // sorted by a persisted field the phone can neither see nor undo.
    const labels = Array.from(head!.querySelectorAll('button')).map(
      (button) => button.textContent?.replace(/[^A-Za-z ]/g, '').trim(),
    );
    expect(labels).toEqual(['Account Name', 'Type', 'Status', 'Balance']);
    // No column label of its own: the one card cell below carries all four.
    expect(head!.textContent).not.toContain('Actions');
  });

  it('offers a sort control for every column the tier header sorts by', () => {
    // The two headers are separate JSX, so this is what ties them together: a
    // fifth sortable column in the tier header fails here until the phone's
    // slim header carries it too.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { accounts: 'normal' } });
    const { container: tier, unmount } = renderList([createAccount()]);
    const tierLabels = Array.from(tier.querySelectorAll('thead th')).map((th) =>
      th.textContent?.replace(/[^A-Za-z ]/g, '').trim(),
    );
    unmount();

    setPhoneViewport(true);
    const { container: phone } = renderList([createAccount()]);
    const phoneLabels = Array.from(phone.querySelectorAll('thead button')).map(
      (button) => button.textContent?.replace(/[^A-Za-z ]/g, '').trim(),
    );

    // The tier header is the sortable columns plus the un-sortable Actions.
    expect(tierLabels).toEqual([...phoneLabels, 'Actions']);
  });

  it('still sorts from the slim header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([
      createAccount({ id: 'a1', name: 'Low Balance', currentBalance: 100 }),
      createAccount({ id: 'a2', name: 'High Balance', currentBalance: 5000 }),
    ]);

    const balanceSort = Array.from(
      container.querySelectorAll<HTMLButtonElement>('thead button'),
    ).find((button) => button.textContent?.includes('Balance'))!;
    expect(balanceSort).toBeTruthy();

    fireEvent.click(balanceSort);
    let rows = accountRows(container);
    expect(rows[0].textContent).toContain('Low Balance');
    expect(rows[1].textContent).toContain('High Balance');

    fireEvent.click(balanceSort);
    rows = accountRows(container);
    expect(rows[0].textContent).toContain('High Balance');
    expect(rows[1].textContent).toContain('Low Balance');
  });

  it('keeps the group header one cell, with its total, and still collapsing', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([
      createAccount({ id: 'a1', name: 'Cheq A', currentBalance: 1500 }),
    ]);

    const [group] = groupRows(container);
    expect(group.querySelectorAll('td')).toHaveLength(1);
    // The group's converted total is not what the single column gave up.
    expect(group.textContent).toContain('$1500.00');
    // The type name is the part that yields, so the header cannot set a
    // minimum width wider than the phone (see the comment on the branch).
    // jsdom does no layout, so this pins the mechanism, not the width: the
    // width itself was measured in a hand-CSS replica at 390px (521px before
    // this shape, 390px after), and only a real-browser case at device width
    // -- the shape `e2e/tests/mobile.spec.ts` uses for the reconcile table --
    // can hold it against a future change.
    expect(group.querySelector('.truncate')).toBeTruthy();
    expect(group.querySelector('.grid')?.className).toContain('minmax(0,1fr)');

    fireEvent.click(group);
    expect(screen.queryByText('Cheq A')).not.toBeInTheDocument();
    fireEvent.click(groupRows(container)[0]);
    expect(screen.getByText('Cheq A')).toBeInTheDocument();
  });

  it('carries a closed account into the card, status and all', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([
      createAccount({ isClosed: true, closedDate: '2024-06-01T00:00:00Z' }),
    ]);

    const [row] = accountRows(container);
    expect(row.querySelectorAll('td')).toHaveLength(1);
    const text = row.textContent ?? '';
    expect(text).toContain('Closed');
    expect(text).not.toContain('Active');
    // Reopen lives in the long-press sheet, like every other row action.
    expect(text).not.toContain('Reopen');
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { accounts: 'compact' } });

    const { container } = renderList([createAccount()]);

    const rows = accountRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
    expect(groupRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { accounts: 'normal' } });

    const { container } = renderList([createAccount()]);

    const rows = accountRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });
});
