import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { ScheduledTransactionList } from './ScheduledTransactionList';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each schedule is a wrapped card in a single `<td>`
 * -- which is how the Account and Schedule this table hides below `sm` and the
 * Category and Auto it hides below `md` get back on screen -- while Compact and
 * Dense keep the tier table, and so does every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants. A separate throwaway spec proved the
 * tier's `container.innerHTML` byte-identical to the merge base across all
 * three densities and every prop that changes a row.
 */

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (n: number, c?: string) => `${c ?? '$'}${n.toFixed(2)}` }),
}));

vi.mock('@/hooks/useLocalizedAmount', () => ({
  useLocalizedAmount: () => (n: number, d?: number) => n.toFixed(d ?? 2),
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { post: vi.fn(), skip: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/errors', () => ({ getErrorMessage: (_e: unknown, fallback: string) => fallback }));

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

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Netflix',
    amount: -15.99,
    currencyCode: 'CAD',
    frequency: 'MONTHLY' as const,
    nextDueDate: ymd(15),
    isActive: true,
    autoPost: false,
    isTransfer: false,
    isSplit: false,
    isInvestment: false,
    account: { name: 'Chequing' },
    category: null,
    payeeName: null,
    payee: null,
    occurrencesRemaining: null,
    overrideCount: 0,
    nextOverride: null,
    ...overrides,
  } as never;
}

function renderList(
  transactions: ReturnType<typeof makeSchedule>[],
  overrides: Record<string, unknown> = {},
) {
  return render(
    <ScheduledTransactionList
      transactions={transactions}
      onEdit={vi.fn()}
      onEditOccurrence={vi.fn()}
      onRefresh={vi.fn()}
      {...overrides}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

describe('the bills list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each schedule as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({
        name: 'Hydro Quebec',
        payeeName: 'Hydro Quebec Distribution',
        amount: -123456.78,
        autoPost: true,
        occurrencesRemaining: 3,
        overrideCount: 2,
        category: { id: 'c1', name: 'Utilities', color: '#22c55e' },
      }),
    ]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // Six of the seven columns, four of them ones a phone-width tier row does
    // not show at all: Account and Schedule are `hidden sm:table-cell`,
    // Category and Auto `hidden md:table-cell`. Everything hanging under a cell
    // rides along too -- the payee sub-line, the occurrences remaining and the
    // "N modified" chip.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('Hydro Quebec');
    expect(text).toContain('Hydro Quebec Distribution');
    expect(text).toContain('CAD123456.78');
    expect(text).toContain(ymd(15));
    expect(text).toContain('Monthly');
    expect(text).toContain('3 left');
    expect(text).toContain('2 modified');
    expect(text).toContain('Chequing');
    expect(text).toContain('Utilities');
    // The auto-post BADGE ("On"), not the caption that names the column
    // ("Auto") -- a `toContain('Auto')` is satisfied by the caption alone, so it
    // would stay green with the marker regressed to the not-auto-posting em dash
    // and the column reporting the opposite of the truth.
    const autoSlot = within(rows[0]).getByText('Auto').parentElement!;
    expect(autoSlot.textContent).toBe('AutoOn');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('omits Actions -- the one column the card drops -- and nothing else', () => {
    // This is the assertion that keeps the code, the `wrapped` prop doc and the
    // rendered card agreeing: a reviewer once found a column rendered while
    // three places said it was omitted.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule()], { onPost: vi.fn() });

    const [row] = bodyRows(container);
    // `RowActions` renders one button per verb; the card renders none.
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('reaches the row actions through the sheet the card sends them to', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no buttons in the card" assertion
    // above would still pass, with no way left to act on a bill from a phone.
    // Right-click is the same route as a 750ms press.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule()], { onPost: vi.fn() });

    const [row] = bodyRows(container);
    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    for (const label of ['Post Transaction', 'Skip Occurrence', 'Edit Occurrence', 'Edit Schedule', 'Delete']) {
      expect(within(sheet).getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('captions every bare value with the column label it lost', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({ account: { name: 'Chequing' }, category: { id: 'c1', name: 'Utilities', color: null } }),
    ]);

    const [row] = bodyRows(container);
    // The captions are their own nodes, above the values', so each value still
    // matches on its own -- which is what keeps `getByText('Chequing')`
    // addressing the account rather than a caption-plus-value blob.
    for (const caption of ['Amount', 'Schedule', 'Account', 'Category', 'Auto']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('Chequing').textContent).toBe('Chequing');
    expect(within(row).getByText('Utilities').textContent).toBe('Utilities');
    // The other side of the auto-post marker: a schedule the user posts by hand
    // draws the muted em dash, which is exactly why this slot is captioned at
    // all -- a bare dash has nothing to say what column it belongs to.
    expect(within(row).getByText('Auto').parentElement!.textContent).toBe('Auto—');

    // The name carries no caption: it is the row's identity, and the tier
    // header's own label for that column ("Name / Payee") would misdescribe a
    // cell that now holds every column at once.
    expect(within(row).queryByText('Name / Payee')).not.toBeInTheDocument();
  });

  it('shows the muted placeholder for an occurrence the server could not price', () => {
    // `null` means unknown. It must never render as a zero, and never as the
    // stored snapshot -- which is exactly what the next test pins from the
    // other side.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({
        amount: -500,
        effectiveAmount: null,
        effectiveAmountComplete: false,
        isInvestment: true,
        investmentAction: 'BUY',
        investmentSecurity: { symbol: 'VTI', name: 'Vanguard Total' },
      }),
    ]);

    const [row] = bodyRows(container);
    const amountSlot = within(row).getByText('Amount').parentElement!;
    expect(amountSlot.textContent).toBe('Amount—');
    expect(amountSlot.textContent).not.toContain('500');
    expect(amountSlot.textContent).not.toContain('0.00');
  });

  it('prints the occurrence\'s effective amount and currency, not the stored snapshot', () => {
    // `ScheduledTransaction.amount` was computed at whatever rate was current
    // when it was written, and it is labelled with the brokerage's currency
    // rather than the settlement account's (issue #1247). The card reads the
    // same component the tier cell does, so the two cannot disagree -- and an
    // override on the next occurrence wins over the schedule's own figure,
    // with the base struck through beside it.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({
        amount: -100,
        currencyCode: 'USD',
        effectiveAmount: -1350,
        effectiveCurrencyCode: 'CAD',
        nextOverride: { overrideDate: ymd(16), amount: -99, effectiveAmount: -1500 },
      }),
    ]);

    const [row] = bodyRows(container);
    const amountSlot = within(row).getByText('Amount').parentElement!;
    expect(amountSlot.textContent).toContain('CAD1500.00');
    expect(amountSlot.textContent).toContain('CAD1350.00');
    expect(amountSlot.textContent).not.toContain('USD');
    expect(amountSlot.textContent).not.toContain('100.00');
  });

  it('puts the overdue chip beside the name and keeps the row tint', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({ id: 's1', name: 'Rent', nextDueDate: ymd(-4) }),
      makeSchedule({ id: 's2', name: 'Netflix', isActive: false }),
    ]);

    const [overdue, inactive] = bodyRows(container);
    // The chip sits in the name row, which is where the tier row's own phone
    // sub-line puts it -- and it is drawn exactly once per card.
    expect(within(overdue).getAllByText('Overdue')).toHaveLength(1);
    const nameRow = within(overdue).getByText('Rent').parentElement!;
    expect(nameRow.textContent).toBe('RentOverdue');
    expect(overdue.className).toContain('bg-red-50');
    // An inactive schedule is dimmed on the card exactly as on the tier row.
    expect(inactive.className).toContain('opacity-50');
    expect(within(inactive).queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('keeps the deep-link flash on the card row', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList(
      [makeSchedule({ id: 's1', name: 'Rent' }), makeSchedule({ id: 's2', name: 'Netflix' })],
      { highlightId: 's2' },
    );

    const rows = bodyRows(container);
    const highlighted = rows.find((row) => row.textContent?.includes('Netflix'))!;
    const other = rows.find((row) => row.textContent?.includes('Rent'))!;
    expect(highlighted.className).toContain('animate-highlight-flash');
    expect(other.className).not.toContain('animate-highlight-flash');
  });

  it('drops the column header rather than replacing it with a slim one', () => {
    // Unlike every other converted list, this header holds NOTHING interactive:
    // the tier `<th>`s are plain labels, and the list has no sort control and no
    // `SortField` of its own -- the Bills page owns ordering and filtering, and
    // the density toggle sits on the page above. So there is no control to
    // carry into a slim header, and a free-standing column label over the one
    // card cell would misdescribe it to a screen reader.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule()]);

    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(0);
    // And the tier header really has no control, so nothing was lost with it.
    // Addressed by the `onClick`/`cursor-pointer` a sortable header would carry,
    // not by position: an interleaved unsortable column breaks a prefix
    // assumption silently.
    setPhoneViewport(false);
    const { container: tier } = renderList([makeSchedule()]);
    expect(tier.querySelectorAll('thead th').length).toBeGreaterThan(1);
    expect(tier.querySelectorAll('thead th[class*="cursor-pointer"]')).toHaveLength(0);
    expect(tier.querySelectorAll('thead button')).toHaveLength(0);
  });

  it('lets the name, the account and the category chip yield rather than widen the table', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([
      makeSchedule({
        name: 'Hydro Quebec Monthly Electricity Bill and Water',
        payeeName: 'Hydro Quebec Distribution Montreal QC',
        nextDueDate: ymd(-2),
        account: { name: 'Joint Chequing Account 4021' },
        category: { id: 'c1', name: 'Utilities and Municipal Services', color: '#22c55e' },
      }),
    ]);

    const [row] = bodyRows(container);
    // jsdom does no layout, so these pin the MECHANISM; the widths were
    // measured in a hand-CSS Chromium replica at 320px and 390px, where
    // `document.documentElement.scrollWidth` and the table's own equal the
    // viewport in both.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(3);
    for (const grid of grids) {
      // A zero-minimum track, spelled either explicitly or as Tailwind's
      // `grid-cols-N` (which compiles to `repeat(N, minmax(0,1fr))`).
      expect(grid.className).toMatch(/minmax\(0,1fr\)|grid-cols-\d/);
    }
    // Line 2 carries two captioned values, so it must name no `auto` track at
    // all: an auto track takes its item's MAX-content, and a caption is a
    // locale-sized width input ("Pianificazione" in `it`), so an auto Schedule
    // slot would starve the Account beside it.
    expect(grids[1].className).not.toContain('auto');

    // The tier lets the name WRAP, so the card clamps rather than truncates --
    // truncating would lose more than the tier does.
    const name = within(row).getByText('Hydro Quebec Monthly Electricity Bill and Water');
    expect(name.className).toContain('line-clamp-2');
    expect(name.className).toContain('min-w-0');
    expect(name.getAttribute('title')).toBe('Hydro Quebec Monthly Electricity Bill and Water');
    // The chip beside it cannot shrink below its own words, so the name row
    // wraps rather than letting the chip take the name's width.
    expect(name.parentElement!.className).toContain('flex-wrap');
    // The account name is the one value here that may truncate.
    const account = within(row).getByText('Joint Chequing Account 4021');
    expect(account.className).toContain('truncate');
    expect(account.getAttribute('title')).toBe('Joint Chequing Account 4021');
    // The category chip is bounded by its own track and truncates inside the
    // chip, the way `CategoryPill` does -- the tier's unbounded chip would
    // overflow into the Auto marker beside it.
    const chip = within(row).getByText('Utilities and Municipal Services');
    expect(chip.className).toContain('truncate');
    expect(chip.parentElement!.className).toContain('max-w-full');
  });

  it('keeps the amount from wrapping, and lets its caption wrap', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule({ amount: -123456.78 })]);

    const [row] = bodyRows(container);
    const caption = within(row).getByText('Amount');
    const value = caption.nextElementSibling as HTMLElement;
    // A locale that groups thousands with a (thin) space would otherwise break
    // the figure in two, and it is never truncated: a silently cut figure is
    // worse than a crowded one.
    expect(value.textContent).toContain('CAD123456.78');
    expect(value.className).toContain('whitespace-nowrap');
    expect(value.className).not.toContain('truncate');
    // The caption must NOT be nowrap: it sits in an `auto` track whose minimum
    // is its item's min-content, so a nowrap caption would size the track from
    // the label rather than from the figure it names.
    expect(caption.className).not.toContain('whitespace-nowrap');
    expect(caption.parentElement!.className).not.toContain('whitespace-nowrap');
  });

  it('uses the density table\'s own inset, not a hand-picked one', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule()]);

    const [row] = bodyRows(container);
    expect(row.querySelector('td')!.className).toBe('p-0');
    expect(row.querySelector('td > div')!.className).toBe('px-3 sm:px-6 py-4');
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'compact' } });

    const { container } = renderList([makeSchedule()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'dense' } });

    const { container } = renderList([makeSchedule()]);

    expect(bodyRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    const { container } = renderList([makeSchedule()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the empty state without a table on a phone', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { bills: 'normal' } });

    renderList([]);

    // There is no `colSpan` empty-state row to reconcile with the wrapped
    // layout's single column: the empty state replaces the table outright.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No scheduled transactions')).toBeInTheDocument();
  });
});
