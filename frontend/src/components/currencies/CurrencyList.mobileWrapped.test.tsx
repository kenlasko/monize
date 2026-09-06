import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { CurrencyList, type CurrencySortField } from './CurrencyList';
import type { CurrencyInfo } from '@/lib/exchange-rates';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each currency is a wrapped card in a single `<td>`
 * -- which is how the name, usage and status this table hides below `sm`, and
 * the decimals it hides below `lg`, get back on screen -- while Compact and
 * Dense keep the tier table, and so does every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants.
 */

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    deleteCurrency: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
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

function makeCurrency(overrides: Partial<CurrencyInfo> & { code: string }): CurrencyInfo {
  return {
    name: 'US Dollar',
    symbol: '$',
    decimalPlaces: 2,
    isActive: true,
    isSystem: false,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

type ListOverrides = {
  usage?: Record<string, { accounts: number; securities: number }>;
  getRate?: (fromCurrency: string, toCurrency?: string) => number | null;
  onSort?: (field: CurrencySortField) => void;
  defaultCurrency?: string;
};

function renderList(currencies: CurrencyInfo[], overrides: ListOverrides = {}) {
  return render(
    <CurrencyList
      currencies={currencies}
      usage={overrides.usage ?? {}}
      defaultCurrency={overrides.defaultCurrency ?? 'CAD'}
      getRate={overrides.getRate ?? (() => null)}
      onEdit={vi.fn()}
      onToggleActive={vi.fn()}
      onRefresh={vi.fn()}
      onSort={overrides.onSort}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

/** A header label with the sort-indicator glyph and the "(CAD)" parens stripped. */
function labelOf(element: Element): string {
  return (element.textContent ?? '').replace(/[^A-Za-z ]/g, '').trim();
}

describe('the currencies list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each currency as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList(
      [makeCurrency({ code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 })],
      {
        usage: { USD: { accounts: 2, securities: 3 } },
        getRate: () => 0.7321,
      },
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // Every column the tier row carries at Normal density except Actions, and
    // five of them are ones a phone-width tier row does not show at all: name,
    // usage and status are `hidden sm:table-cell`, decimals `hidden lg:table-cell`.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('USD');
    expect(text).toContain('US Dollar');
    expect(text).toContain('$');
    expect(text).toContain('2 accts, 3 secs');
    expect(text).toContain('0.732100');
    expect(text).toContain('Active');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('reaches Edit and Delete through the action sheet the card sends them to', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no Edit/Delete in the card"
    // assertions above would still pass, with no way left to edit a currency on
    // a phone. Right-click is the same route as a 750ms press.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })]);

    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Edit');

    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit Currency' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete Currency' })).toBeInTheDocument();
  });

  it('captions every bare value with the column label it lost', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList(
      [makeCurrency({ code: 'USD', symbol: '$', decimalPlaces: 4 })],
      { usage: { USD: { accounts: 1, securities: 0 } }, getRate: () => 0.7321 },
    );

    const [row] = bodyRows(container);
    // The captions are their own nodes, above the values', so each value still
    // matches on its own -- which is what keeps `getByText('0.732100')`
    // addressing the rate rather than a caption-plus-value blob.
    for (const caption of ['Rate (CAD)', 'Symbol', 'Decimals', 'Usage']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('0.732100').textContent).toBe('0.732100');
    expect(within(row).getByText('4').textContent).toBe('4');
    expect(within(row).getByText('1 acct').textContent).toBe('1 acct');

    // The code, the "Default" marker and the status pill carry no caption: the
    // code is the row's identity and the other two are self-describing pills.
    expect(within(row).queryByText('Code')).not.toBeInTheDocument();
    expect(within(row).queryByText('Status')).not.toBeInTheDocument();
  });

  it('shows the exchange rate at the FX display precision, not money precision', () => {
    // An exchange rate is not money: 4dp would round 0.7321499 to 0.7321,
    // which inverts back cents off on a four-figure amount. The card reads the
    // same helper the tier cell does, so the two cannot drift apart.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })], {
      getRate: () => 0.7321499,
    });

    const [row] = bodyRows(container);
    expect(within(row).getByText('0.732150')).toBeInTheDocument();
    expect(within(row).queryByText('0.7321')).not.toBeInTheDocument();
  });

  it('says N/A for an unresolved rate and "-" for the base currency', () => {
    // A failed lookup is unknown, never 1 and never a blank that reads as zero;
    // the base currency has no rate to state at all. Two different absences,
    // and the card keeps them apart exactly as the tier cell does.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList(
      [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' }), makeCurrency({ code: 'USD' })],
      {
        getRate: () => null,
        // Both currencies are in use, so the only "-" left on either card is
        // the base currency's rate -- the Usage column has its own placeholder.
        usage: { CAD: { accounts: 1, securities: 0 }, USD: { accounts: 1, securities: 0 } },
      },
    );

    const [base, foreign] = bodyRows(container);
    expect(within(base).getByText('-')).toBeInTheDocument();
    expect(within(base).queryByText('N/A')).not.toBeInTheDocument();
    expect(within(foreign).getByText('N/A')).toBeInTheDocument();
  });

  it('keeps the Default marker and the status pill beside the name', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([
      makeCurrency({ code: 'CAD', name: 'Canadian Dollar' }),
      makeCurrency({ code: 'USD', isActive: false }),
    ]);

    const [base, foreign] = bodyRows(container);
    expect(within(base).getByText('Default')).toBeInTheDocument();
    expect(within(base).getByText('Active')).toBeInTheDocument();
    expect(within(foreign).queryByText('Default')).not.toBeInTheDocument();
    expect(within(foreign).getByText('Inactive')).toBeInTheDocument();
  });

  it('replaces the column header with a slim sort header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })]);

    const head = container.querySelector('thead')!;
    expect(head.querySelectorAll('th')).toHaveLength(1);
    // Every sortable field survives as a button. Fewer would leave a list
    // sorted by a persisted field the phone can neither see nor undo -- and
    // Name and Decimals are exactly the columns this table hides on a phone.
    const labels = Array.from(head.querySelectorAll('button')).map(labelOf);
    expect(labels).toEqual(['Code', 'Name', 'Symbol', 'Decimals', 'Rate CAD']);
    // No column label of its own: the one card cell below carries all of them.
    expect(head.textContent).not.toContain('Actions');
    expect(head.textContent).not.toContain('Status');
    expect(head.textContent).not.toContain('Usage');
    // The arrow glyph in a button is not a state, so the direction is
    // announced on the `<th>`.
    expect(head.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('offers a sort control for every column the tier header sorts by', () => {
    // The two headers are separate JSX, so this is what ties them together: a
    // sixth sortable column in the tier header fails here until the phone's
    // slim header carries it too. The tier header's sortable cells are the ones
    // carrying `cursor-pointer`; Usage, Status and Actions have no control.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { currencies: 'normal' } });
    const { container: tier, unmount } = renderList([makeCurrency({ code: 'USD' })]);
    const tierLabels = Array.from(
      tier.querySelectorAll('thead th[class*="cursor-pointer"]'),
    ).map(labelOf);
    expect(tier.querySelectorAll('thead th').length).toBeGreaterThan(tierLabels.length);
    unmount();

    setPhoneViewport(true);
    const { container: phone } = renderList([makeCurrency({ code: 'USD' })]);
    const phoneLabels = Array.from(phone.querySelectorAll('thead button')).map(labelOf);

    expect(phoneLabels).toEqual(tierLabels);
  });

  it('still sorts from the slim header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const onSort = vi.fn();
    const { container } = renderList([makeCurrency({ code: 'USD' })], { onSort });

    // The page owns the ordering (and persists the field), so the claim here is
    // that every button reaches it -- including the two fields whose columns a
    // phone cannot see.
    for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('thead button'))) {
      fireEvent.click(button);
    }
    expect(onSort.mock.calls.map(([field]) => field)).toEqual([
      'code',
      'name',
      'symbol',
      'decimals',
      'rate',
    ]);
  });

  it('lets the name and the usage text truncate rather than widen the table', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList(
      [makeCurrency({ code: 'BAM', name: 'Convertible mark of Bosnia and Herzegovina' })],
      { usage: { BAM: { accounts: 128, securities: 256 } } },
    );

    const [row] = bodyRows(container);
    // jsdom does no layout, so this pins the mechanism, not the width: a
    // truncating region needs a grid track with an explicit zero minimum,
    // because a flex item's `min-w-0` still contributes the full width of its
    // nowrap text to the table's minimum. The width itself was measured in a
    // hand-CSS replica at 320px, 390px and 800px.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid.className).toContain('minmax(0,1fr)');
    }
    expect(row.querySelectorAll('.truncate').length).toBe(2);
  });

  it('lets the pills yield a line rather than the name its width', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([
      makeCurrency({ code: 'CAD', name: 'Convertible mark of Bosnia and Herzegovina' }),
    ]);

    const [row] = bodyRows(container);
    const nameRow = row.querySelector('.truncate')!.parentElement!;
    // The name truncates, so it is the only item here that can shrink; the
    // "Default" marker and the status pill cannot shrink below their one word
    // and would otherwise take their width out of the name's. jsdom does no
    // layout, so this pins the mechanism; the widths were measured in the
    // replica.
    expect(nameRow.className).toContain('flex-wrap');
    expect(nameRow.className).toContain('min-w-0');
  });

  it('gives the currency code a fixed slot so the names line up down the card', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([
      makeCurrency({ code: 'USD' }),
      makeCurrency({ code: 'JPY', symbol: '¥' }),
    ]);

    // An `auto` track would step the name column left and right from row to row
    // as the code's glyphs change width -- a ragged edge only a screenshot
    // shows. An ISO code is exactly three characters, so a fixed slot fits.
    for (const row of bodyRows(container)) {
      const code = row.querySelector('.grid > span')!;
      expect(code.className).toContain('w-12');
      expect(code.className).toContain('shrink-0');
    }
  });

  it('keeps the money-free rate from wrapping mid-number', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })], { getRate: () => 0.7321 });

    const [row] = bodyRows(container);
    // A locale that groups with a (thin) space would otherwise break the figure
    // in two, and the figure is never truncated: a silently cut rate is worse
    // than a crowded one.
    const rateCell = within(row).getByText('0.732100').closest('div')!.parentElement!;
    expect(rateCell.className).toContain('whitespace-nowrap');
    expect(rateCell.className).not.toContain('truncate');
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'compact' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'dense' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })]);

    const rows = bodyRows(container);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    const { container } = renderList([makeCurrency({ code: 'USD' })]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the empty state without a table on a phone', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { currencies: 'normal' } });

    renderList([]);

    // There is no `colSpan` empty-state row to reconcile with the wrapped
    // column count: the empty state replaces the table outright.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No currencies')).toBeInTheDocument();
  });
});
