import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { InstitutionList } from './InstitutionList';
import { Institution } from '@/types/institution';
import { useDensityStore } from '@/store/densityStore';

/**
 * Model B: on a phone the density toggle picks the LAYOUT, not only the row
 * height. At Normal density each institution is a wrapped card in a single
 * `<td>` -- which is how the Website and Country this table hides below `md`
 * and `sm` get back on screen -- while Compact and Dense keep the tier table,
 * and so does every non-phone width.
 *
 * These are the combinations that decide it. The rest of the list's suite runs
 * under the harness's default `matchMedia` (`matches: false`), so it exercises
 * the tier table exactly as before -- which is the point of choosing the branch
 * in JS rather than with CSS variants.
 */

vi.mock('@/lib/institutions', () => ({
  institutionsApi: { delete: vi.fn().mockResolvedValue(undefined) },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
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

function makeInstitution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: 'i-1',
    userId: 'u-1',
    name: 'TD Canada Trust',
    website: 'https://td.com',
    country: 'CA',
    hasLogo: true,
    logoFetchedAt: null,
    createdAt: '',
    updatedAt: '',
    accountCount: 2,
    ...overrides,
  };
}

function renderList(
  institutions: Institution[],
  props: Partial<React.ComponentProps<typeof InstitutionList>> = {},
) {
  return render(
    <InstitutionList
      institutions={institutions}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onManageAccounts={vi.fn()}
      sortField="name"
      sortDirection="asc"
      onSort={vi.fn()}
      {...props}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));
}

/** A header cell or button's label with the sort-indicator glyph stripped. */
function labelOf(element: Element): string {
  return (element.textContent ?? '').replace(/[^A-Za-z ]/g, '').trim();
}

describe('the institutions list on a phone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useDensityStore.setState({ densities: {} });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders each institution as a wrapped card at Normal density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    // The whole card lives in one cell -- that is what makes it a card rather
    // than a table row with its columns squeezed.
    expect(rows[0].querySelectorAll('td')).toHaveLength(1);

    // More of the institution than a phone-width tier table shows, all in the
    // one row: the website this table hides below `md` and the country it
    // hides below `sm`, beside the name and the account count.
    const text = rows[0].textContent ?? '';
    expect(text).toContain('TD Canada Trust');
    expect(text).toContain('https://td.com');
    expect(text).toContain('CA');
    expect(text).toContain('2');

    // The row actions stay in the long-press action sheet on phones.
    expect(text).not.toContain('Edit');
    expect(text).not.toContain('Delete');
  });

  it('reaches Edit and Delete through the action sheet the card sends them to', () => {
    // The card drops the Actions column, so this is the claim that makes that
    // safe. Without it the suite would stay green if `getRowHandlers` stopped
    // being spread on the wrapped row: the "no Edit/Delete in the card"
    // assertions would still pass, with no way left to edit an institution on
    // a phone. Right-click is the same route as a 750ms press.
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()]);

    const [row] = bodyRows(container);
    expect(row.textContent).not.toContain('Edit');

    fireEvent.contextMenu(row);

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('captions every value whose column header the card lost', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution({ accountCount: 42 })]);

    const [row] = bodyRows(container);
    // Each caption is its own node, so the value still matches on its own --
    // which is what keeps `getByText('42')` addressing the account count.
    for (const caption of ['Accounts', 'Country', 'Website']) {
      expect(within(row).getByText(caption)).toBeInTheDocument();
    }
    expect(within(row).getByText('42').textContent).toBe('42');
    expect(within(row).getByText('CA').textContent).toBe('CA');
    expect(within(row).getByText('https://td.com').textContent).toBe('https://td.com');
    // The captions reuse this table's own column labels, so no translation key
    // was added: the header offers the same four words.
    const headerLabels = Array.from(
      container.querySelectorAll('thead button'),
    ).map(labelOf);
    expect(headerLabels).toEqual(expect.arrayContaining(['Accounts', 'Country', 'Website']));
  });

  it('keeps the account count a control that opens the accounts manager', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const onManageAccounts = vi.fn();
    const { container } = renderList([makeInstitution()], { onManageAccounts });

    const [row] = bodyRows(container);
    fireEvent.click(within(row).getByRole('button', { name: '2 accounts' }));
    expect(onManageAccounts).toHaveBeenCalledTimes(1);
  });

  it('keeps the website an external link, and only for http(s) schemes', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container, rerender } = renderList([makeInstitution()]);

    const link = within(bodyRows(container)[0]).getByRole('link', {
      name: 'https://td.com',
    });
    expect(link).toHaveAttribute('href', 'https://td.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // The link-or-plain-text decision is the tier row's, rendered from the same
    // helper: a `javascript:` URI must not reach an `href` in either layout.
    rerender(
      <InstitutionList
        institutions={[makeInstitution({ website: 'javascript:alert(1)' })]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onManageAccounts={vi.fn()}
        sortField="name"
        sortDirection="asc"
        onSort={vi.fn()}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
  });

  it('keeps the em-dash placeholder for an institution with no country', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution({ country: null })]);

    // What the Country column shows, from the same helper the tier cell uses:
    // the row keeps saying it has a country field rather than the value simply
    // vanishing.
    expect(within(bodyRows(container)[0]).getByText('—')).toBeInTheDocument();
  });

  it('replaces the column header with a slim sort header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()]);

    const head = container.querySelector('thead')!;
    expect(head.querySelectorAll('th')).toHaveLength(1);
    // Every sortable field survives as a button. Fewer would leave a list
    // sorted by a field the phone can neither see nor undo -- and Website and
    // Country are exactly the columns this table hides on a phone.
    expect(Array.from(head.querySelectorAll('button')).map(labelOf)).toEqual([
      'Name',
      'Website',
      'Country',
      'Accounts',
    ]);
    // No column label of its own: the one card cell below carries all of them.
    expect(head.textContent).not.toContain('Actions');
    // The arrow glyph in a button is not a state, so the direction is
    // announced on the `<th>`.
    expect(head.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('announces the direction it was given', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()], {
      sortField: 'accounts',
      sortDirection: 'desc',
    });

    // Honest because the slim header names `accounts` itself; a field it did
    // not name would have to withhold the direction.
    expect(container.querySelector('thead th')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('offers a sort control for every column the tier header sorts by', () => {
    // The two headers share one field list, so this is what proves it: a fifth
    // sortable column in the tier header fails here until the phone's slim
    // header carries it too.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { institutions: 'normal' } });
    const { container: tier, unmount } = renderList([makeInstitution()]);
    const tierLabels = Array.from(tier.querySelectorAll('thead th')).map(labelOf);
    unmount();

    setPhoneViewport(true);
    const { container: phone } = renderList([makeInstitution()]);
    const phoneLabels = Array.from(phone.querySelectorAll('thead button')).map(labelOf);

    // The tier header is the sortable columns plus the one that is not.
    expect(tierLabels).toEqual([...phoneLabels, 'Actions']);
  });

  it('keeps each tier header cell its own responsive visibility token', () => {
    // The tier header is built from the same list as the slim one, and its
    // visibility class is concatenated against the next token. Read off
    // `classList` rather than the raw string, so a missing separator --
    // `md:table-cellcursor-pointer`, which destroys the responsive class while
    // the bare `hidden` survives and takes the column off every width -- fails
    // here instead of only in a screenshot.
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()]);

    const tokensByLabel = new Map(
      Array.from(container.querySelectorAll('thead th')).map((th) => [
        labelOf(th),
        Array.from(th.classList),
      ]),
    );
    // Website surfaces at `md` and Country at `sm`; the other two are always on.
    expect(tokensByLabel.get('Website')).toEqual(
      expect.arrayContaining(['hidden', 'md:table-cell', 'cursor-pointer']),
    );
    expect(tokensByLabel.get('Country')).toEqual(
      expect.arrayContaining(['hidden', 'sm:table-cell', 'cursor-pointer']),
    );
    for (const label of ['Name', 'Accounts']) {
      expect(tokensByLabel.get(label)).not.toContain('hidden');
      expect(tokensByLabel.get(label)).toContain('cursor-pointer');
    }
  });

  it('still sorts from the slim header', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const onSort = vi.fn();
    const { container } = renderList([makeInstitution()], { onSort });

    const countrySort = Array.from(
      container.querySelectorAll<HTMLButtonElement>('thead button'),
    ).find((button) => labelOf(button) === 'Country')!;
    expect(countrySort).toBeTruthy();

    fireEvent.click(countrySort);
    expect(onSort).toHaveBeenCalledWith('country');
  });

  it('hides the header outright when it holds no sort control', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()], { onSort: undefined });

    const head = container.querySelector('thead')!;
    // Nothing interactive is left to keep, and a bare column label would
    // misdescribe the single card cell below it.
    expect(head.querySelectorAll('button')).toHaveLength(0);
    expect(head.className).toContain('hidden');
    // `aria-sort` may only announce a direction for a field this header names,
    // and it names none.
    expect(head.querySelector('th')!.hasAttribute('aria-sort')).toBe(false);
  });

  it('lets the name and the website truncate rather than widen the table', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([
      makeInstitution({
        name: 'Toronto-Dominion Bank of Canada Trust',
        website: 'https://www.td.com/ca/en/personal-banking/products/chequing-accounts',
      }),
    ]);

    const [row] = bodyRows(container);
    // jsdom does no layout, so this pins the mechanism, not the width: a
    // truncating region needs a grid track with an explicit zero minimum,
    // because a flex item's `min-w-0` still contributes the full width of its
    // nowrap text to the table's minimum. The widths themselves were measured
    // in a hand-CSS replica at 320px and 390px.
    const grids = Array.from(row.querySelectorAll<HTMLElement>('.grid'));
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid.className).toContain('minmax(0,1fr)');
    }
    // The name and the website are the two values that can outgrow the card.
    expect(row.querySelectorAll('.truncate')).toHaveLength(2);
  });

  it('keeps the tier table at Compact density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'compact' } });

    const { container } = renderList([makeInstitution()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('keeps the tier table at Dense density', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'dense' } });

    const { container } = renderList([makeInstitution()]);

    expect(bodyRows(container)[0].querySelectorAll('td').length).toBeGreaterThan(1);
  });

  it('keeps the tier table on a desktop width at Normal density', () => {
    setPhoneViewport(false);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    const { container } = renderList([makeInstitution()]);

    const rows = bodyRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelectorAll('td').length).toBeGreaterThan(1);
    expect(container.querySelector('thead')!.querySelectorAll('th').length).toBeGreaterThan(1);
  });

  it('renders the empty state without a table on a phone', () => {
    setPhoneViewport(true);
    useDensityStore.setState({ densities: { institutions: 'normal' } });

    renderList([]);

    // There is no `colSpan` empty-state row to reconcile with the wrapped
    // column count: the empty state replaces the table outright.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(
      screen.getByText('No institutions yet. Create one to start grouping your accounts.'),
    ).toBeInTheDocument();
  });
});
