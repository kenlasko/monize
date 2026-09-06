import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { SecurityList, type SecuritySortField } from './SecurityList';
import { useDensityStore } from '@/store/densityStore';
import { FALLBACK_DEFAULT_CURRENCY } from '@/lib/default-currency';
import { formatCurrency } from '@/lib/format';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each security is a wrapped card in a single `<td>`
 * -- which is how the exchange, currency and status this table hides below `sm`
 * and the provider and source it hides below `md` get back on screen -- while
 * Compact and Dense keep the tier table, and so does every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants.
 */

// The reader states no preference here, so their own currency is the fallback
// -- derived, never spelled, so these cases keep meaning what their names say
// if that constant moves. A foreign currency has to be a code it can never be.
const READER_CURRENCY = FALLBACK_DEFAULT_CURRENCY;
const FOREIGN_CURRENCY = 'JPY';

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

function makeSecurity(overrides: Record<string, unknown> = {}): any {
  return {
    id: 's1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    exchange: 'NASDAQ',
    currencyCode: READER_CURRENCY,
    isActive: true,
    isFavourite: false,
    skipPriceUpdates: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

type ListOverrides = {
  holdings?: Record<string, number>;
  onSort?: (field: SecuritySortField) => void;
  onToggleFavourite?: (security: any) => void;
  onOpen?: (security: any) => void;
  onDelete?: (security: any) => void;
};

function renderList(securities: any[], overrides: ListOverrides = {}) {
  return render(
    <SecurityList
      securities={securities}
      holdings={overrides.holdings}
      onEdit={vi.fn()}
      onToggleActive={vi.fn()}
      onOpen={overrides.onOpen ?? vi.fn()}
      onDelete={overrides.onDelete}
      onToggleFavourite={overrides.onToggleFavourite}
      onSort={overrides.onSort}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

/** A header label with the sort-indicator glyph stripped. */
function labelOf(element: Element): string {
  return (element.textContent ?? '').replace(/[^A-Za-z ]/g, '').trim();
}

function onPhoneAtNormal() {
  setPhoneViewport(true);
  useDensityStore.setState({ densities: { securities: 'normal' } });
}

describe('the securities list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each security as a wrapped card at Normal density', () => {
    onPhoneAtNormal();

    const { container } = renderList(
      [
        makeSecurity({
          lastPrice: 250,
          lastPriceSource: 'manual',
          quoteProvider: 'msn',
        }),
      ],
      { holdings: { s1: 4 } },
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // Every column the tier row carries at Normal density except Actions, and
    // five of them are ones a phone-width tier row does not show at all:
    // exchange, currency and status are `hidden sm:table-cell`, provider and
    // source `hidden md:table-cell`.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('AAPL');
    expect(text).toContain('Apple Inc.');
    expect(text).toContain('Stock');
    expect(text).toContain('4');
    expect(text).toContain(formatCurrency(1000, READER_CURRENCY));
    expect(text).toContain(READER_CURRENCY);
    expect(text).toContain('NASDAQ');
    expect(text).toContain('MSN');
    expect(text).toContain('Manual');
    expect(text).toContain('Active');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('reaches Edit and Delete through the action sheet the card sends them to', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no Edit/Delete in the card"
    // assertions above would still pass, with no way left to edit a security on
    // a phone. Right-click is the same route as a 750ms press.
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity()], { onDelete: vi.fn() });

    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Edit');

    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit Security' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('captions every bare value with the column label it lost', () => {
    onPhoneAtNormal();

    const { container } = renderList(
      [makeSecurity({ lastPrice: 10, lastPriceSource: 'yahoo_finance' })],
      { holdings: { s1: 2.5 } },
    );

    const [row] = bodyRows(container);
    // The captions are their own nodes, above the values', so each value still
    // matches on its own -- which is what keeps `getByText('2.5')` addressing
    // the share count rather than a caption-plus-value blob.
    for (const caption of ['Value', 'Type', 'Shares', 'Currency', 'Exchange', 'Provider', 'Source']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('2.5').textContent).toBe('2.5');
    expect(within(row).getByText('NASDAQ').textContent).toBe('NASDAQ');
    expect(within(row).getByText(formatCurrency(25, READER_CURRENCY)).textContent).toBe(
      formatCurrency(25, READER_CURRENCY),
    );

    // The symbol, the name and the status pill carry no caption: the first two
    // are the row's identity and the third is a self-describing pill. The
    // favourite column's header was an `sr-only` label, and there is no column
    // left for it to name.
    expect(within(row).queryByText('Symbol')).not.toBeInTheDocument();
    expect(within(row).queryByText('Name')).not.toBeInTheDocument();
    expect(within(row).queryByText('Status')).not.toBeInTheDocument();
    expect(within(row).queryByText('Favourite')).not.toBeInTheDocument();
  });

  it('draws an unpriced holding as unknown, never as zero', () => {
    // A held position whose price never arrived is a value nobody knows. The
    // card reads the same helper the tier cell does, so it cannot render a
    // figure the table withholds -- and `0` would state the position is
    // worthless.
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity({ lastPrice: null })], {
      holdings: { s1: 7 },
    });

    const [row] = bodyRows(container);
    expect(within(row).getByTestId('unknown-amount')).toBeInTheDocument();
    expect(within(row).queryByText(formatCurrency(0, READER_CURRENCY))).not.toBeInTheDocument();
  });

  it('draws a security nobody holds as a measured zero', () => {
    // The converse, and the reason the branch above is not "null when in
    // doubt": nothing held really is worth nothing, whatever the price does,
    // and no price is needed to say so.
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity({ lastPrice: null })]);

    const [row] = bodyRows(container);
    expect(within(row).queryByTestId('unknown-amount')).not.toBeInTheDocument();
    expect(within(row).getByText(formatCurrency(0, READER_CURRENCY))).toBeInTheDocument();
  });

  it('names the currency of a value quoted in one that is not the reader own', () => {
    // The value is never converted, so a bare symbol would leave a foreign
    // figure reading as the reader's money.
    onPhoneAtNormal();

    const { container } = renderList(
      [makeSecurity({ currencyCode: FOREIGN_CURRENCY, lastPrice: 100 })],
      { holdings: { s1: 3 } },
    );

    const [row] = bodyRows(container);
    const expected = `${formatCurrency(300, FOREIGN_CURRENCY)} ${FOREIGN_CURRENCY}`;
    expect(within(row).getByText(expected)).toBeInTheDocument();
  });

  it('keeps the favourite star interactive without opening the security', () => {
    // The star is a control inside a clickable row: both branches render the
    // same component, and its click must act on itself rather than on the row
    // underneath.
    onPhoneAtNormal();

    const onToggleFavourite = vi.fn();
    const onOpen = vi.fn();
    renderList([makeSecurity()], { onToggleFavourite, onOpen });

    fireEvent.click(screen.getByTitle('Add to favourites'));
    expect(onToggleFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows a favourited security with its star pressed', () => {
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity({ isFavourite: true })], {
      onToggleFavourite: vi.fn(),
    });

    const [row] = bodyRows(container);
    const star = within(row).getByTitle('Remove from favourites');
    expect(star.getAttribute('aria-pressed')).toBe('true');
  });

  it('dims an inactive security and keeps its status pill', () => {
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity({ isActive: false })]);

    const [row] = bodyRows(container);
    expect(row.className).toContain('opacity-60');
    expect(within(row).getByText('Inactive')).toBeInTheDocument();
  });

  it('carries the tags and the description that hang under the name', () => {
    // A phone at Normal density showed both before this card existed, so
    // dropping them would lose information the wrap exists to recover.
    onPhoneAtNormal();

    const { container } = renderList([
      makeSecurity({
        description: 'Global aggregate bond ETF.',
        tags: [{ id: 't1', name: 'Core', color: '#3366ff' }],
      }),
    ]);

    const [row] = bodyRows(container);
    expect(within(row).getByText('Core')).toBeInTheDocument();
    expect(within(row).getByText('Global aggregate bond ETF.')).toBeInTheDocument();
  });

  it('replaces the column header with a slim sort header', () => {
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity()]);

    const head = container.querySelector('thead')!;
    expect(head.querySelectorAll('th')).toHaveLength(1);
    // Every sortable field survives as a button. Fewer would leave a list
    // sorted by a persisted field the phone can neither see nor undo -- and
    // Exchange, Currency, Provider and Source are exactly the columns this
    // table hides at phone width.
    const labels = Array.from(head.querySelectorAll('button')).map(labelOf);
    expect(labels).toEqual([
      'Symbol',
      'Name',
      'Type',
      'Shares',
      'Value',
      'Exchange',
      'Currency',
      'Provider',
      'Source',
    ]);
    // No column label of its own: the one card cell below carries all of them,
    // and the favourite column's `sr-only` label is not a sort control.
    expect(head.textContent).not.toContain('Actions');
    expect(head.textContent).not.toContain('Status');
    expect(head.textContent).not.toContain('Favourite');
    // The arrow glyph in a button is not a state, so the direction is
    // announced on the `<th>`.
    expect(head.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('offers a sort control for every column the tier header sorts by', () => {
    // The two headers are separate JSX, so this is what ties them together: a
    // tenth sortable column in the tier header fails here until the phone's
    // slim header carries it too. The tier header's sortable cells are the ones
    // carrying `cursor-pointer`; Favourite, Status and Actions have no control,
    // so a positional assumption would break silently.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { securities: 'normal' } });
    const { container: tier, unmount } = renderList([makeSecurity()]);
    const tierLabels = Array.from(
      tier.querySelectorAll('thead th[class*="cursor-pointer"]'),
    ).map(labelOf);
    expect(tier.querySelectorAll('thead th').length).toBeGreaterThan(tierLabels.length);
    unmount();

    setPhoneViewport(true);
    const { container: phone } = renderList([makeSecurity()]);
    const phoneLabels = Array.from(phone.querySelectorAll('thead button')).map(labelOf);

    expect(phoneLabels).toEqual(tierLabels);
  });

  it('still sorts from the slim header', () => {
    onPhoneAtNormal();

    const onSort = vi.fn();
    const { container } = renderList([makeSecurity()], { onSort });

    // The page owns the ordering (and persists the field), so the claim here is
    // that every button reaches it -- including the four fields whose columns a
    // phone cannot see.
    for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('thead button'))) {
      fireEvent.click(button);
    }
    expect(onSort.mock.calls.map(([field]) => field)).toEqual([
      'symbol',
      'name',
      'type',
      'shares',
      'value',
      'exchange',
      'currency',
      'provider',
      'source',
    ]);
  });

  it('clamps a long name over two lines rather than cutting it to one', () => {
    // The tier's name cell carries no `whitespace-nowrap`, so a phone at Normal
    // density has always wrapped a long name and shown it whole. Truncating to
    // one line here would take that away on the exact width this card converts,
    // and a `title` is not the way back on a device with no pointer. The box
    // still wraps inside a `minmax(0,1fr)` track, so it contributes no minimum
    // width -- the containment measured in the replica is unchanged.
    onPhoneAtNormal();

    const longName = 'Vanguard FTSE Global All Cap Index ETF Fund';
    const { container } = renderList([makeSecurity({ name: longName })]);

    const [row] = bodyRows(container);
    const name = within(row).getByText(longName);
    expect(name.className).toContain('line-clamp-2');
    expect(name.className).not.toContain('truncate');
    expect(name.getAttribute('title')).toBe(longName);
  });

  it('lets the name and the type yield rather than widen the table', () => {
    onPhoneAtNormal();

    const { container } = renderList([
      makeSecurity({
        name: 'Vanguard FTSE Global All Cap Index ETF Fund',
        securityType: 'MUTUAL_FUND',
      }),
    ]);

    const [row] = bodyRows(container);
    // jsdom does no layout, so this pins the mechanism, not the width: a
    // truncating region needs a grid track with an explicit zero minimum,
    // because a flex item's `min-w-0` still contributes the full width of its
    // nowrap text to the table's minimum. The widths themselves were measured
    // in a hand-CSS replica at 320px, 390px and 800px.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid.className).toContain('minmax(0,1fr)');
    }
    // The name wraps and clamps, the symbol and the type text truncate: three
    // regions with a zero minimum, none of which can widen the table.
    expect(row.querySelectorAll('.line-clamp-2').length).toBeGreaterThanOrEqual(1);
    expect(row.querySelectorAll('.truncate').length).toBeGreaterThanOrEqual(2);
  });

  it('gives the symbol a slot with a floor and a ceiling', () => {
    onPhoneAtNormal();

    // The floor keeps the name column starting at the same x down the card --
    // an `auto` track would step it left and right as the symbol's glyphs
    // change width, a ragged edge only a screenshot shows. The ceiling bounds
    // what a pathological 20-character symbol (the form's maximum) can take out
    // of the name, since the slot never wraps.
    const { container } = renderList([
      makeSecurity(),
      makeSecurity({ id: 's2', symbol: 'BRK.B' }),
    ]);

    for (const row of bodyRows(container)) {
      const symbol = row.querySelector('.grid > div > span')!;
      expect(symbol.className).toContain('min-w-[3.25rem]');
      expect(symbol.className).toContain('max-w-[6rem]');
    }
  });

  it('keeps the money figure from wrapping mid-number and never truncates it', () => {
    onPhoneAtNormal();

    const { container } = renderList([makeSecurity({ lastPrice: 123456.78 })], {
      holdings: { s1: 1 },
    });

    const [row] = bodyRows(container);
    // A locale that groups thousands with a (thin) space would otherwise break
    // the figure in two, and it is never truncated: a silently cut amount is
    // worse than a crowded one.
    const valueCell = within(row)
      .getByText(formatCurrency(123456.78, READER_CURRENCY))
      .parentElement!;
    expect(valueCell.className).toContain('whitespace-nowrap');
    expect(valueCell.className).not.toContain('truncate');
  });

  it('keeps the deep-link flash on the wrapped row', () => {
    onPhoneAtNormal();

    const { container } = render(
      <SecurityList
        securities={[makeSecurity()]}
        onEdit={vi.fn()}
        onToggleActive={vi.fn()}
        onOpen={vi.fn()}
        highlightId="s1"
      />,
    );

    const [row] = bodyRows(container);
    expect(row.className).toContain('animate-highlight-flash');
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { securities: 'compact' } });

    const { container } = renderList([makeSecurity()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { securities: 'dense' } });

    const { container } = renderList([makeSecurity()]);

    expect(bodyRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { securities: 'normal' } });

    const { container } = renderList([makeSecurity()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the empty state without a table on a phone', () => {
    onPhoneAtNormal();

    renderList([]);

    // There is no `colSpan` empty-state row to reconcile with the wrapped
    // column count: the empty state replaces the table outright.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No securities')).toBeInTheDocument();
  });
});
