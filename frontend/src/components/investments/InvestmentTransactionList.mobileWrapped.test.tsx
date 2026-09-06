import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { InvestmentTransactionList, type TransactionFilters } from './InvestmentTransactionList';
import { investmentsApi } from '@/lib/investments';
import { TransactionStatus } from '@/types/transaction';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each trade is a wrapped card in a single `<td>` --
 * which is how the Shares this register hides below `sm`, the Price it hides
 * below `md`, and the Account and Status it hides below `lg` get back on
 * screen -- while Compact and Dense keep the tier table, and so does every
 * non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants.
 */

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    updateStatus: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _code?: string, digits?: number) => `$${n.toFixed(digits ?? 2)}`,
    formatQuantity: (n: number) => String(n),
    numberFormat: 'en-US',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ defaultCurrency: 'CAD' }),
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

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'Questrade Registered Retirement Savings Plan' },
  { id: 'a2', name: 'Wealthsimple TFSA' },
];

function makeTx(overrides: Record<string, unknown> = {}): any {
  return {
    id: 't1',
    action: 'BUY',
    transactionDate: '2024-01-15',
    accountId: 'a1',
    security: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'CAD' },
    quantity: 10,
    price: 150,
    totalAmount: 1500,
    status: TransactionStatus.UNRECONCILED,
    ...overrides,
  };
}

type ListOverrides = {
  transactions?: any[];
  onEdit?: (tx: any) => void;
  onDelete?: (id: string) => void;
  densityView?: 'investments' | 'accountRegister';
  filters?: TransactionFilters;
  onFiltersChange?: (filters: TransactionFilters) => void;
};

function renderList(overrides: ListOverrides = {}) {
  const {
    transactions = [makeTx()],
    onEdit = vi.fn(),
    onDelete = vi.fn(),
    ...rest
  } = overrides;
  return render(
    <InvestmentTransactionList
      transactions={transactions}
      accounts={ACCOUNTS}
      isLoading={false}
      onEdit={onEdit}
      onDelete={onDelete}
      {...rest}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

describe('the investment register on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each trade as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // Eight of the nine columns, four of them ones a phone-width tier row does
    // not show at all: Shares is `hidden sm:table-cell`, Price
    // `hidden md:table-cell`, Account and Status `hidden lg:table-cell`.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('2024-01-15');
    expect(text).toContain('Buy');
    expect(text).toContain('AAPL');
    expect(text).toContain('Apple Inc.');
    expect(text).toContain('10');
    expect(text).toContain('$150.0000');
    expect(text).toContain('$1500.00');
    expect(text).toContain('Questrade Registered Retirement Savings Plan');
    expect(text).toContain('Pending');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('omits only the Actions column, and reaches it through the sheet instead', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no Edit/Delete in the card"
    // assertion above would still pass, with no way left to edit a trade on a
    // phone. Right-click is the same route as a 750ms press.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();
    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Edit');

    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('captions every bare value with the column label it lost', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();
    const [row] = bodyRows(container);

    // The captions are their own nodes, above the values', so each value still
    // matches on its own -- which is what keeps `getByText('$1500.00')`
    // addressing the figure rather than a caption-plus-value blob.
    for (const caption of ['Total', 'Shares', 'Price', 'Account']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('$1500.00').textContent).toBe('$1500.00');
    expect(within(row).getByText('10').textContent).toBe('10');

    // The date is the row's identity and the action, the symbol and the status
    // name themselves, so none of the four takes a caption.
    for (const caption of ['Date', 'Action', 'Symbol', 'Status']) {
      expect(within(row).queryByText(caption)).not.toBeInTheDocument();
    }
  });

  it('drops the column header, which holds no control to keep', () => {
    // Unlike the cash register (a date-view toggle and a select-all box) and
    // the list tables (a sort control per column), this register's header row
    // is labels only: it offers no sortable column at any width, so there is
    // nothing a slim phone header would have to carry, and a `<th>` bearing
    // one of the eight labels would misdescribe the single card cell below.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();

    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelectorAll('table th')).toHaveLength(0);
  });

  it('strands no sort order, because the tier header offers none either', () => {
    // The parity claim that makes dropping the header safe, addressed by the
    // presence of a control rather than by position: the moment a sortable
    // `<th>` (a click handler, spelled as `cursor-pointer` on every list that
    // has one) appears in the tier header, the phone loses the only way to
    // reach or undo it and this fails.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();

    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells.length).toBeGreaterThan(1);
    expect(headerCells.filter((th) => th.className.includes('cursor-pointer'))).toEqual([]);
  });

  it('renders the shares, price and total through the tier row\'s own helpers', () => {
    // A SPLIT's `quantity` is a RATIO, not a share count, and a redemption's
    // total is its proceeds plus the accrued interest that moved with them.
    // Both are decisions rather than labels, so the card calls the same
    // renderers the tier cells do; a duplicated reading is how the two layouts
    // would come to describe one row differently.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [
        makeTx({ id: 's1', action: 'SPLIT', quantity: 2, price: null }),
        makeTx({
          id: 's2',
          action: 'REDEEM',
          totalAmount: 1000,
          accruedInterest: 25,
          security: { symbol: 'BOND', name: 'A Bond', currencyCode: 'CAD' },
        }),
      ],
    });

    const [split, redeem] = bodyRows(container);
    expect(within(split).getByText('2:1')).toBeInTheDocument();
    // A SPLIT with no price is a dash, never a measured $0.00.
    expect(within(split).getByText('-')).toBeInTheDocument();
    expect(within(redeem).getByText('$1025.00')).toBeInTheDocument();
  });

  it('names the security\'s currency on the total when it is not the reader\'s', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [
        makeTx({ security: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD' } }),
      ],
    });

    const [row] = bodyRows(container);
    // A bare figure in the reader's default currency is what the code beside
    // it exists to prevent, so the card carries the suffix the tier cell does.
    expect(within(row).getAllByText('USD').length).toBeGreaterThan(0);
  });

  it('keeps a VOID row struck through and dimmed', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [makeTx({ status: TransactionStatus.VOID })],
    });

    const [row] = bodyRows(container);
    expect(row.className).toContain('opacity-50');
    // A VOID row records something that did not happen: the date and the three
    // figures are struck through, exactly as in the tier cells.
    expect(within(row).getByText('2024-01-15').className).toContain('line-through');
    expect(within(row).getByText('10').className).toContain('line-through');
  });

  it('cycles the status from the card without opening the row', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const onEdit = vi.fn();
    const { container } = renderList({ onEdit });

    const [row] = bodyRows(container);
    act(() => {
      fireEvent.click(within(row).getByText('Pending'));
    });

    expect(investmentsApi.updateStatus).toHaveBeenCalledWith('t1', TransactionStatus.CLEARED);
    // The control stops the row's own click, or tapping the status would also
    // open the edit form.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('spans one column on both of the table\'s spanning rows', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    // A future-dated trade leads the list, so the "Today" divider is drawn
    // between it and the past one.
    const { container } = renderList({
      transactions: [
        makeTx({ id: 'future', transactionDate: '2999-01-01' }),
        makeTx({ id: 'past', transactionDate: '2024-01-15' }),
      ],
    });

    const divider = bodyRows(container).find((row) => row.textContent?.includes('Today'))!;
    expect(divider.querySelector('td')!.getAttribute('colspan')).toBe('1');

    const { container: filtered } = renderList({
      transactions: [],
      filters: { symbol: 'AAPL' },
      onFiltersChange: vi.fn(),
    });
    const [empty] = bodyRows(filtered);
    expect(empty.querySelector('td')!.getAttribute('colspan')).toBe('1');
  });

  it('spans every column on those rows in the tier table', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [
        makeTx({ id: 'future', transactionDate: '2999-01-01' }),
        makeTx({ id: 'past', transactionDate: '2024-01-15' }),
      ],
    });

    const divider = bodyRows(container).find((row) => row.textContent?.includes('Today'))!;
    // Eight data columns plus Actions, which this surface offers.
    expect(divider.querySelector('td')!.getAttribute('colspan')).toBe('9');
  });

  it('lets the symbol, the security name and the account truncate rather than widen the table', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [
        makeTx({
          security: {
            symbol: 'BRK.B',
            name: 'Berkshire Hathaway Inc. Class B Common',
            currencyCode: 'CAD',
          },
        }),
      ],
    });

    const [row] = bodyRows(container);
    // jsdom does no layout, so this pins the mechanism, not the width: a
    // truncating region needs a grid track with an explicit zero minimum,
    // because a flex item's `min-w-0` still contributes the full width of its
    // nowrap text to the table's minimum. The widths themselves were measured
    // in a hand-CSS replica at 320px, 390px and 800px.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(3);
    for (const grid of grids) {
      // A zero-minimum track, spelled either explicitly or as Tailwind's
      // `grid-cols-N` (which compiles to `repeat(N, minmax(0,1fr))`).
      expect(grid.className).toMatch(/minmax\(0,1fr\)|grid-cols-\d/);
    }
    // Line 2 carries two captioned figures, and it is where an `auto` track
    // would do the damage: an auto track takes its item's MAX-content, so a
    // captioned neighbour starves the track beside it. Equal fr tracks stop
    // that, so this line names no `auto` track at all.
    expect(grids[1].className).not.toContain('auto');

    // Line 1 has exactly ONE `auto` track -- the Total. It used to have two,
    // with the date in its own, and an auto track takes MAX-content: at 320px
    // a nowrap date and a six-figure `pl` Total left the identity 69px, so
    // `break-words` shattered the longest action label across seven lines
    // (237px of row for one trade). The date rides inside the identity track
    // now, which measures 162px at 320px and 231px at 390px in the replica.
    expect(grids[0].className).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(within(row).getByText('2024-01-15').parentElement).toBe(
      within(row).getByText('BRK.B').parentElement,
    );

    // The symbol and the account name truncate; the SECURITY NAME does not.
    // The tier's Symbol cell lets that name wrap (no `whitespace-nowrap`), so
    // cutting it to one line here would lose more than the tier does --
    // `line-clamp-2` keeps two and contains identically, because a wrapping
    // box adds no minimum width either.
    expect(row.querySelectorAll('.truncate')).toHaveLength(2);
    const secName = within(row).getByText('Berkshire Hathaway Inc. Class B Common');
    expect(secName.className).toContain('line-clamp-2');
    expect(secName.className).not.toContain('truncate');
    expect(secName.getAttribute('title')).toBe('Berkshire Hathaway Inc. Class B Common');
  });

  it('lets a long action label yield a line rather than the symbol its width', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList({
      transactions: [makeTx({ action: 'REINVEST_CAPITAL_GAIN_LONG' })],
    });

    const [row] = bodyRows(container);
    const label = within(row).getByText('Reinvest Long-Term Cap Gain');
    // The symbol truncates, so it is the only item on this line that can
    // shrink; the action label cannot shrink below its own words -- and they
    // run to 49 characters in `pl`. Wrapping lets it take its own line instead
    // of taking the symbol's width, and `break-words` handles the locale whose
    // single longest word still overruns a 320px track.
    expect(label.parentElement!.className).toContain('flex-wrap');
    expect(label.className).toContain('break-words');
    expect(label.className).toContain('min-w-0');
  });

  it('keeps the figures from wrapping, and lets their captions wrap', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();
    const [row] = bodyRows(container);

    // A locale that groups with a (thin) space would otherwise break a figure
    // in two, and none of them is truncated: a silently cut figure is worse
    // than a crowded one.
    for (const value of ['10', '$150.0000', '$1500.00']) {
      const node = within(row).getByText(value);
      expect(node.className).toContain('whitespace-nowrap');
      expect(node.className).not.toContain('truncate');
    }

    // The CAPTIONS above them must NOT be nowrap: a caption is a locale-sized
    // width input, and a nowrap one sizes its track from the label rather than
    // from the figure it labels.
    for (const caption of ['Total', 'Shares', 'Price', 'Account']) {
      const node = within(row).getByText(caption);
      expect(node.className).not.toContain('whitespace-nowrap');
      expect(node.parentElement!.className).not.toContain('whitespace-nowrap');
    }
  });

  it('uses the density table\'s own wide inset, not a hand-picked one', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();
    const [row] = bodyRows(container);

    // Two insets on one screen misalign. This register reads the `wide` scale
    // -- a narrower phone inset than every other table's, because it carries
    // more -- and the card takes that same value rather than a literal.
    expect(row.querySelector('td')!.className).toBe('p-0');
    expect(row.querySelector('td > div')!.className).toBe('px-2 sm:px-6 py-3 sm:py-4');
  });

  it('wraps on the account detail page\'s register too', () => {
    // The list is mounted from two surfaces and each remembers its own
    // density. Both carry the same columns, so both wrap -- and the card must
    // follow the level stored for the surface it is rendering for.
    setPhoneViewport(true);
    useDensityStore.setState({
      densities: { accountRegister: 'normal', investments: 'dense' },
    });

    const { container } = renderList({ densityView: 'accountRegister' });

    const [row] = bodyRows(container);
    expect(row.querySelectorAll('td')).toHaveLength(1);
  });

  it('keeps the tier table for a surface whose remembered level is not Normal', () => {
    setPhoneViewport(true);
    useDensityStore.setState({
      densities: { accountRegister: 'compact', investments: 'normal' },
    });

    const { container } = renderList({ densityView: 'accountRegister' });

    const [row] = bodyRows(container);
    expect(row.querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'compact' } });

    const { container } = renderList();

    const [row] = bodyRows(container);
    expect(row.querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'dense' } });

    const { container } = renderList();

    const [row] = bodyRows(container);
    expect(row.querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    const { container } = renderList();

    const [row] = bodyRows(container);
    expect(row.querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the unfiltered empty state without a table on a phone', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { investments: 'normal' } });

    renderList({ transactions: [] });

    // With no filter active the list replaces the table outright, so there is
    // no spanning row to reconcile with the wrapped column count.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No investment transactions yet.')).toBeInTheDocument();
  });
});
