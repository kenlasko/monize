import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { PayeeList, type SortField } from './PayeeList';
import { Payee } from '@/types/payee';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each payee is a wrapped card in a single `<td>` --
 * which is how the Default Category and Status this table hides below `sm`, the
 * Count it hides below `md`, and the Aliases and Last Used it hides below `lg`
 * get back on screen -- while Compact and Dense keep the tier table, and so does
 * every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants.
 */

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/payees',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: { delete: vi.fn().mockResolvedValue(undefined) },
  // The card's brand badge builds its src from this; the real helper is a pure
  // string builder, so the mock mirrors it rather than stubbing it away.
  payeeLogoUrl: (id: string) => `/api/v1/payees/${id}/logo`,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
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

const GROCERIES = {
  id: 'cat-1',
  userId: 'user-1',
  parentId: null,
  parent: null,
  children: [],
  name: 'Groceries',
  description: null,
  icon: null,
  color: '#22c55e',
  effectiveColor: '#22c55e',
  effectiveIcon: null,
  isIncome: false,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as NonNullable<Payee['defaultCategory']>;

function makePayee(overrides: Partial<Payee> & { id: string; name: string }): Payee {
  return {
    userId: 'user-1',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    website: null,
    hasLogo: false,
    logoFetchedAt: null,
    contactLookupAt: null,
    contactLookupSource: null,
    address: null,
    email: null,
    phone: null,
    isActive: true,
    createdAt: '2020-05-05T00:00:00Z',
    transactionCount: 0,
    ...overrides,
  } as Payee;
}

type ListOverrides = {
  showStatusColumn?: boolean;
  onSort?: (field: SortField) => void;
  highlightId?: string | null;
};

function renderList(payees: Payee[], overrides: ListOverrides = {}) {
  return render(
    <PayeeList
      payees={payees}
      onEdit={vi.fn()}
      onRefresh={vi.fn()}
      onMerge={vi.fn()}
      onReactivate={vi.fn()}
      showStatusColumn={overrides.showStatusColumn}
      onSort={overrides.onSort}
      highlightId={overrides.highlightId}
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

describe('the payees list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each payee as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList(
      [
        makePayee({
          id: 'p1',
          name: 'Walmart',
          transactionCount: 12345,
          aliasCount: 3,
          lastUsedDate: '2026-08-30T00:00:00Z',
          notes: 'Weekly groceries run',
          defaultCategory: GROCERIES,
        }),
      ],
      { showStatusColumn: true },
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // Seven of the nine columns, five of them ones a phone-width tier row does
    // not show at all: Default Category and Status are `hidden sm:table-cell`,
    // Count `hidden md:table-cell`, Aliases and Last Used `hidden lg:table-cell`.
    // (Name and Notes are the two a phone already shows; Created and Actions
    // are the two the card omits.)
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Walmart');
    expect(text).toContain('12345');
    expect(text).toContain('Groceries');
    expect(text).toContain('Active');
    expect(text).toContain('2026-08-30');
    expect(text).toContain('3');
    expect(text).toContain('Weekly groceries run');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('omits Created -- the one column the card drops -- and says so nowhere else', () => {
    // Nine columns do not fit three lines, so Created is omitted deliberately
    // (see the `wrapped` prop doc). This is the assertion that keeps the code,
    // the comment and the rendered card agreeing: a reviewer once found a
    // column rendered while three places said it was omitted.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([
      makePayee({
        id: 'p1',
        name: 'Walmart',
        createdAt: '2020-05-05T00:00:00Z',
        lastUsedDate: '2026-08-30T00:00:00Z',
      }),
    ]);

    const [row] = bodyRows(container);
    expect(row.textContent).toContain('2026-08-30');
    expect(row.textContent).not.toContain('2020-05-05');
    expect(within(row).queryByText('Created')).not.toBeInTheDocument();
  });

  it('reaches the row actions through the sheet the card sends them to', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no Edit/Delete in the card"
    // assertions above would still pass, with no way left to edit a payee on a
    // phone. Right-click is the same route as a 750ms press.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Edit');

    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Merge' })).toBeInTheDocument();
  });

  it('captions every bare value with the column label it lost', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList(
      [
        makePayee({
          id: 'p1',
          name: 'Walmart',
          transactionCount: 41,
          aliasCount: 7,
          lastUsedDate: '2026-08-30T00:00:00Z',
          notes: 'Weekly groceries run',
          defaultCategory: GROCERIES,
        }),
      ],
      { showStatusColumn: true },
    );

    const [row] = bodyRows(container);
    // The captions are their own nodes, above the values', so each value still
    // matches on its own -- which is what keeps `getByText('2026-08-30')`
    // addressing the date rather than a caption-plus-value blob.
    for (const caption of ['Count', 'Default Category', 'Last Used', 'Aliases', 'Notes']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('41').textContent).toBe('41');
    expect(within(row).getByText('7').textContent).toBe('7');
    expect(within(row).getByText('2026-08-30').textContent).toBe('2026-08-30');

    // The name and the status pill carry no caption: the name is the row's
    // identity, and "Active"/"Inactive" name themselves. Default Category is
    // captioned despite being a pill here, because its other branch is the bare
    // word "None" -- see the card's line-2 comment.
    expect(within(row).queryByText('Name')).not.toBeInTheDocument();
    expect(within(row).queryByText('Status')).not.toBeInTheDocument();
  });

  it('puts the count and the aliases together on line 1, and the pills alone on line 2', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList(
      [makePayee({ id: 'p1', name: 'Walmart', transactionCount: 41, aliasCount: 7, defaultCategory: GROCERIES })],
      { showStatusColumn: true },
    );

    const [row] = bodyRows(container);
    const [card, line2] = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    // Both figures are direct children of the card grid -- line 1 -- with the
    // name; neither lives in the line-2 grid, which holds the two pills.
    const directChildren = Array.from(card.children);
    const countBox = within(row).getByText('41').parentElement!;
    const aliasesBox = within(row).getByText('7').parentElement!;
    expect(directChildren).toContain(countBox);
    expect(directChildren).toContain(aliasesBox);
    expect(line2.textContent).not.toContain('Aliases');
    expect(line2.textContent).toContain('Groceries');
    expect(line2.textContent).toContain('Active');
    // Four tracks on line 1: logo, name, count, aliases.
    expect(card.className).toContain('grid-cols-[auto_minmax(0,1fr)_auto_auto]');
  });

  it('shows the "None" category placeholder rather than a blank', () => {
    // A payee with no default category is a known state, not an unknown one,
    // and the card reads the same helper the tier cell does so the two cannot
    // come to disagree about what "no category" looks like.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const [row] = bodyRows(container);
    const none = within(row).getByText('None');
    expect(none).toBeInTheDocument();
    // And it is captioned: uncaptioned, this line reads "None" with nothing to
    // say what of, because the card dropped the column header that said so.
    expect(none.parentElement!.textContent).toBe('Default CategoryNone');
    // An unused payee has never been used and has no notes: both are "-", not
    // an empty cell.
    expect(within(row).getAllByText('-').length).toBe(2);
  });

  it('keeps the uncategorized marker beside the name and the status pill on line 2', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList(
      [
        makePayee({ id: 'p1', name: 'Walmart', uncategorizedCount: 4 }),
        makePayee({ id: 'p2', name: 'Netflix', isActive: false }),
      ],
      { showStatusColumn: true },
    );

    // The badge's copy is an ICU plural, so next-intl hands React the count and
    // the words as separate nodes -- matched on the row's text, not a node's.
    const [inactive, flagged] = bodyRows(container);
    expect(flagged.textContent).toContain('4 uncategorized');
    expect(within(flagged).getByText('Active')).toBeInTheDocument();
    expect(inactive.textContent).not.toContain('uncategorized');
    expect(within(inactive).getByText('Inactive')).toBeInTheDocument();
    // An inactive payee is dimmed on the card exactly as on the tier row.
    expect(inactive.className).toContain('opacity-60');
  });

  it('shows the status pill only where the tier table would show that column', () => {
    // `showStatusColumn` is the Payees page's own decision (it is off while the
    // list is filtered to active payees). A card that ignored it would show a
    // column the table does not.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const [row] = bodyRows(container);
    expect(within(row).queryByText('Active')).not.toBeInTheDocument();
  });

  it('draws the payee logo on the card, where the tier cell hides it', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([
      makePayee({ id: 'p1', name: 'Walmart', hasLogo: true }),
    ]);

    const [row] = bodyRows(container);
    const logo = row.querySelector('img')!;
    expect(logo.getAttribute('src')).toBe('/api/v1/payees/p1/logo');
    // The tier cell spells its responsive hiding `max-sm:hidden`; the card has
    // the room, so it hides the logo at no width -- and never with a bare
    // `hidden`, which Tailwind emits first and which a later display utility
    // on the fallback badge would beat.
    expect(logo.className).not.toContain('hidden');
  });

  it('opens the payee\'s transactions from the name without opening the row', () => {
    // A control inside the card must stop the row's own click, or tapping the
    // name would navigate twice.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const [row] = bodyRows(container);
    fireEvent.click(within(row).getByRole('button', { name: 'Walmart' }));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/transactions?payeeId=p1');
  });

  it('keeps the deep-link flash on the card row', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList(
      [makePayee({ id: 'p1', name: 'Walmart' }), makePayee({ id: 'p2', name: 'Netflix' })],
      { highlightId: 'p2' },
    );

    // The list sorts by name, so address the rows by the payee they carry
    // rather than by position.
    const rows = bodyRows(container);
    const highlighted = rows.find((row) => row.textContent?.includes('Netflix'))!;
    const other = rows.find((row) => row.textContent?.includes('Walmart'))!;
    expect(highlighted.className).toContain('animate-highlight-flash');
    expect(other.className).not.toContain('animate-highlight-flash');
  });

  it('replaces the column header with a slim sort header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const head = container.querySelector('thead')!;
    expect(head.querySelectorAll('th')).toHaveLength(1);
    // Every sortable field survives as a button. Fewer would leave a list
    // sorted by a persisted field the phone can neither see nor undo -- and
    // five of these six columns are exactly the ones this table hides on a
    // phone.
    const labels = Array.from(head.querySelectorAll('button')).map(labelOf);
    expect(labels).toEqual(['Name', 'Default Category', 'Count', 'Aliases', 'Last Used', 'Created']);
    // No column label of its own: the one card cell below carries all of them.
    expect(head.textContent).not.toContain('Actions');
    expect(head.textContent).not.toContain('Status');
    expect(head.textContent).not.toContain('Notes');
    // The arrow glyph in a button is not a state, so the direction is
    // announced on the `<th>` -- honestly, because the buttons name every
    // member of `SortField`.
    expect(head.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
    // These chips are tapped, so each carries a real hit target rather than
    // being a bare 16px text run.
    for (const button of Array.from(head.querySelectorAll('button'))) {
      expect(button.className).toContain('min-h-[30px]');
      expect(button.className).toContain('px-2');
    }
  });

  it('offers a sort control for every column the tier header sorts by', () => {
    // The two headers are separate JSX, so this is what ties them together: a
    // seventh sortable column in the tier header fails here until the phone's
    // slim header carries it too. The tier header's sortable cells are the ones
    // carrying `cursor-pointer`; Status, Notes and Actions have no control, and
    // they sit AFTER the sortable ones, so a contiguous-prefix assumption would
    // pass here for the wrong reason.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { payees: 'normal' } });
    const { container: tier, unmount } = renderList(
      [makePayee({ id: 'p1', name: 'Walmart' })],
      { showStatusColumn: true },
    );
    const tierLabels = Array.from(
      tier.querySelectorAll('thead th[class*="cursor-pointer"]'),
    ).map(labelOf);
    expect(tier.querySelectorAll('thead th').length).toBeGreaterThan(tierLabels.length);
    unmount();

    setPhoneViewport(true);
    const { container: phone } = renderList([makePayee({ id: 'p1', name: 'Walmart' })], {
      showStatusColumn: true,
    });
    const phoneLabels = Array.from(phone.querySelectorAll('thead button')).map(labelOf);

    expect(phoneLabels).toEqual(tierLabels);
  });

  it('still sorts from the slim header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const onSort = vi.fn();
    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })], { onSort });

    // The page owns the ordering (and persists the field in
    // `monize-payees-sort-field`), so the claim here is that every button
    // reaches it -- including the five fields whose columns a phone cannot see.
    for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('thead button'))) {
      fireEvent.click(button);
    }
    expect(onSort.mock.calls.map(([field]) => field)).toEqual([
      'name',
      'category',
      'count',
      'aliases',
      'lastUsed',
      'createdAt',
    ]);
  });

  it('lets the name, the category pill and the notes truncate rather than widen the table', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([
      makePayee({
        id: 'p1',
        name: 'Walmart Supercentre Downtown Toronto Ontario',
        notes: 'A long note that runs past the width of any phone ever made',
        defaultCategory: GROCERIES,
      }),
    ]);

    const [row] = bodyRows(container);
    // jsdom does no layout, so this pins the mechanism, not the width: a
    // truncating region needs a grid track with an explicit zero minimum,
    // because a flex item's `min-w-0` still contributes the full width of its
    // nowrap text to the table's minimum. The width itself was measured in a
    // hand-CSS replica at 320px, 390px and 800px.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(3);
    for (const grid of grids) {
      // A zero-minimum track, spelled either explicitly or as Tailwind's
      // `grid-cols-N` (which compiles to `repeat(N, minmax(0,1fr))`).
      expect(grid.className).toMatch(/minmax\(0,1fr\)|grid-cols-\d/);
    }
    // Line 3 carries the only truncating value with no pill or button of its
    // own to bound it, and it is where an `auto` track did real damage: an auto
    // track takes its item's MAX-content, so a captioned neighbour starved
    // Notes to 19px in `ru` while measuring 127px in English. Equal fr tracks
    // are what stop that, so this line must name no `auto` track at all.
    const line3 = grids[2];
    expect(line3.className).not.toContain('auto');
    // The name, the pill's own inner label and the notes.
    expect(row.querySelectorAll('.truncate').length).toBe(3);
  });

  it('lets the uncategorized marker yield a line rather than the name its width', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([
      makePayee({
        id: 'p1',
        name: 'Walmart Supercentre Downtown Toronto Ontario',
        uncategorizedCount: 12,
      }),
    ]);

    const [row] = bodyRows(container);
    const nameRow = within(row).getByRole('button', { name: /Walmart/ }).parentElement!;
    // The name truncates, so it is the only item here that can shrink; the
    // "N uncategorized" marker cannot shrink below its own words and would
    // otherwise take its width out of the name's. jsdom does no layout, so this
    // pins the mechanism; the widths were measured in the replica.
    expect(nameRow.className).toContain('flex-wrap');
    expect(nameRow.className).toContain('min-w-0');
  });

  it('keeps the values from wrapping, and lets their captions wrap', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([
      makePayee({
        id: 'p1',
        name: 'Walmart',
        transactionCount: 12345,
        aliasCount: 3,
        lastUsedDate: '2026-08-30T00:00:00Z',
      }),
    ]);

    const [row] = bodyRows(container);
    // A locale that groups with a (thin) space would otherwise break a figure
    // in two, and none of them is truncated: a silently cut count is worse than
    // a crowded one.
    for (const value of ['12345', '3', '2026-08-30']) {
      const node = within(row).getByText(value);
      expect(node.className).toContain('whitespace-nowrap');
      expect(node.className).not.toContain('truncate');
    }

    // The CAPTIONS above them must NOT be nowrap. Each sits in an `auto` grid
    // track, whose minimum is its item's min-content -- so a nowrap caption
    // sizes the track from the label rather than the value, and
    // `list.columns.lastUsed` is "Последнее использование" in `ru`. That would
    // squeeze the Notes track to about 30px on a 320px phone in eleven locales
    // while measuring fine in English.
    for (const caption of ['Count', 'Last Used', 'Aliases']) {
      const node = within(row).getByText(caption);
      expect(node.className).not.toContain('whitespace-nowrap');
      expect(node.parentElement!.className).not.toContain('whitespace-nowrap');
    }
  });

  it('uses the density table\'s own inset, not a hand-picked one', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const [row] = bodyRows(container);
    // Two insets on one screen misalign, and the slim header above these cards
    // is padded from the same table.
    expect(row.querySelector('td')!.className).toBe('p-0');
    expect(row.querySelector('td > div')!.className).toBe('px-3 sm:px-6 py-4');
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'compact' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'dense' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const rows = bodyRows(container);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    const { container } = renderList([makePayee({ id: 'p1', name: 'Walmart' })]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the empty state without a table on a phone', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { payees: 'normal' } });

    renderList([]);

    // There is no `colSpan` empty-state row to reconcile with the wrapped
    // column count: the empty state replaces the table outright.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No payees')).toBeInTheDocument();
  });
});
