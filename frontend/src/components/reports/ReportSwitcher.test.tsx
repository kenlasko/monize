import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ReportSwitcher } from './ReportSwitcher';
import { customReportsApi } from '@/lib/custom-reports';
import { investmentReportsApi } from '@/lib/investment-reports';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';

vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: { getAll: vi.fn() },
}));

vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: { getAll: vi.fn() },
}));

// The built-in favourites live in the reactive preferences store; only
// `favouriteReportIds` is read here, so the rest of the object is cast in.
function setFavouriteReportIds(ids: string[]) {
  usePreferencesStore.setState({
    preferences: { favouriteReportIds: ids } as UserPreferences,
  });
}

const push = vi.fn();

// Picking a report navigates; the switcher builds the route itself, so that is
// what these tests assert on.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/tax-summary',
  useSearchParams: () => new URLSearchParams(),
}));

const getCustom = vi.mocked(customReportsApi.getAll);
const getInvestment = vi.mocked(investmentReportsApi.getAll);

async function openSwitcher(currentId = 'tax-summary') {
  await act(async () => {
    render(<ReportSwitcher currentId={currentId} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Switch to another report' }));
  });
}

describe('ReportSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCustom.mockResolvedValue([]);
    getInvestment.mockResolvedValue([]);
    // No favourites by default, so the section-order tests see only the
    // category sections. Reset explicitly -- the store is a singleton.
    setFavouriteReportIds([]);
  });

  it('groups the reports by section, in the order the Reports page lists them', async () => {
    // Opened from an Insights report, which has four siblings, so no section
    // disappears for having had its only report removed.
    await openSwitcher('monthly-comparison');
    const sections = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    // Every section that has a report in it, in REPORT_CATEGORIES order.
    expect(sections).toEqual([
      'Spending',
      'Income',
      'Net Worth',
      'Tax',
      'Debt & Loans',
      'Investment',
      'Insights',
      'Maintenance',
      'Bills',
      'Budget',
    ]);
  });

  it('files each report under its own section', async () => {
    await openSwitcher();
    const spending = screen.getByRole('group', { name: 'Spending' });
    expect(
      within(spending).getByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeInTheDocument();
    const budget = screen.getByRole('group', { name: 'Budget' });
    expect(
      within(budget).getByRole('menuitem', { name: /Savings Rate/ }),
    ).toBeInTheDocument();
  });

  it('lists the report on screen, highlighted, under its own category', async () => {
    await openSwitcher('investment-performance');
    const investment = screen.getByRole('group', { name: 'Investment' });
    const current = within(investment).getByRole('menuitem', {
      name: /Investment Performance/,
    });
    expect(current).toHaveAttribute('aria-current', 'true');
    // Picking it again only closes the menu.
    fireEvent.click(current);
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('files a starred current report beside its siblings, not in Favourites', async () => {
    // Shown in Favourites, the menu would open at the top, away from the other
    // Tax reports the reader is likely switching to.
    setFavouriteReportIds(['tax-summary']);
    await openSwitcher();
    // It was the only favourite, so there is no Favourites section.
    expect(screen.queryByRole('group', { name: 'Favourites' })).toBeNull();
    const tax = screen.getByRole('group', { name: 'Tax' });
    expect(
      within(tax).getByRole('menuitem', { name: /^Tax Summary/ }),
    ).toHaveAttribute('aria-current', 'true');
    expect(
      within(tax).getByRole('menuitem', { name: /Payroll Deductions/ }),
    ).toBeInTheDocument();
  });

  it("lists the user's custom and investment reports under their sections", async () => {
    getCustom.mockResolvedValue([
      { id: 'c1', name: 'Groceries Deep Dive' },
    ] as unknown as Awaited<ReturnType<typeof customReportsApi.getAll>>);
    getInvestment.mockResolvedValue([
      { id: 'i1', name: 'RRSP Holdings' },
    ] as unknown as Awaited<ReturnType<typeof investmentReportsApi.getAll>>);

    await openSwitcher();
    const custom = screen.getByRole('group', { name: 'Custom' });
    expect(
      within(custom).getByRole('menuitem', { name: /Groceries Deep Dive/ }),
    ).toBeInTheDocument();
    const investment = screen.getByRole('group', { name: 'Investment' });
    expect(
      within(investment).getByRole('menuitem', { name: /RRSP Holdings/ }),
    ).toBeInTheDocument();

    // The id is the route the switcher builds.
    fireEvent.click(screen.getByRole('menuitem', { name: /RRSP Holdings/ }));
    expect(push).toHaveBeenCalledWith('/reports/investment/i1');
  });

  it('reports the built-in catalog when the saved reports cannot be loaded', async () => {
    // A failed lookup is not an empty list of reports: the built-ins are still
    // known, and the switcher stays usable rather than showing nothing.
    getCustom.mockRejectedValue(new Error('offline'));
    getInvestment.mockRejectedValue(new Error('offline'));
    await openSwitcher();
    await act(async () => {});
    expect(
      screen.getByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeInTheDocument();
  });

  it('navigates to the report that was picked', async () => {
    await openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Net Worth Over Time/ }));
    expect(push).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('filters across a list this long', async () => {
    await openSwitcher();
    fireEvent.change(screen.getByPlaceholderText('Filter reports...'), {
      target: { value: 'dividend' },
    });
    expect(
      screen.getByRole('menuitem', { name: /Dividend Yield & Growth/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Savings Rate/ })).toBeNull();
  });

  it('lifts favourite built-in reports into a Favourites section at the top', async () => {
    setFavouriteReportIds(['savings-rate', 'net-worth']);
    await openSwitcher('monthly-comparison');

    // Favourites is the first section the caret shows.
    const sections = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    expect(sections[0]).toBe('Favourites');

    const favourites = screen.getByRole('group', { name: 'Favourites' });
    expect(
      within(favourites).getByRole('menuitem', { name: /Savings Rate/ }),
    ).toBeInTheDocument();
    expect(
      within(favourites).getByRole('menuitem', { name: /Net Worth Over Time/ }),
    ).toBeInTheDocument();
  });

  it('shows a favourite once -- not also under its own category', async () => {
    setFavouriteReportIds(['savings-rate']);
    await openSwitcher('monthly-comparison');

    // Savings Rate is a Budget report; favouriting it moves it out of Budget.
    const budget = screen.getByRole('group', { name: 'Budget' });
    expect(
      within(budget).queryByRole('menuitem', { name: /Savings Rate/ }),
    ).toBeNull();
    // And it appears exactly once across the whole menu.
    expect(screen.getAllByRole('menuitem', { name: /Savings Rate/ })).toHaveLength(
      1,
    );
  });

  it('lifts favourite custom and investment reports into Favourites', async () => {
    getCustom.mockResolvedValue([
      { id: 'c1', name: 'Groceries Deep Dive', isFavourite: true },
      { id: 'c2', name: 'Utilities', isFavourite: false },
    ] as unknown as Awaited<ReturnType<typeof customReportsApi.getAll>>);
    getInvestment.mockResolvedValue([
      { id: 'i1', name: 'RRSP Holdings', isFavourite: true },
    ] as unknown as Awaited<ReturnType<typeof investmentReportsApi.getAll>>);

    await openSwitcher();
    const favourites = screen.getByRole('group', { name: 'Favourites' });
    expect(
      within(favourites).getByRole('menuitem', { name: /Groceries Deep Dive/ }),
    ).toBeInTheDocument();
    expect(
      within(favourites).getByRole('menuitem', { name: /RRSP Holdings/ }),
    ).toBeInTheDocument();

    // The non-favourite custom report stays under its own section.
    const custom = screen.getByRole('group', { name: 'Custom' });
    expect(
      within(custom).getByRole('menuitem', { name: /Utilities/ }),
    ).toBeInTheDocument();
    expect(
      within(custom).queryByRole('menuitem', { name: /Groceries Deep Dive/ }),
    ).toBeNull();
  });

  it('reorders immediately when a favourite is toggled', async () => {
    await openSwitcher('monthly-comparison');
    // Nothing starred yet, so no Favourites section.
    expect(screen.queryByRole('group', { name: 'Favourites' })).toBeNull();

    // Toggling a favourite anywhere updates the reactive preference, and the
    // open menu reorders without reopening.
    await act(async () => {
      usePreferencesStore
        .getState()
        .updatePreferences({ favouriteReportIds: ['spending-by-category'] });
    });

    const favourites = screen.getByRole('group', { name: 'Favourites' });
    expect(
      within(favourites).getByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeInTheDocument();
    const spending = screen.getByRole('group', { name: 'Spending' });
    expect(
      within(spending).queryByRole('menuitem', { name: /Spending by Category/ }),
    ).toBeNull();
  });

  it('orders the Favourites section by REPORT_CATEGORIES, not by insertion order', async () => {
    // favouriteReportIds lists networth before spending, but the source claims
    // the top section reads in REPORT_CATEGORIES order (spending before
    // networth) -- guard that claim so a future reorder cannot pass silently.
    setFavouriteReportIds(['net-worth', 'spending-by-category']);
    await openSwitcher('monthly-comparison');
    const favourites = screen.getByRole('group', { name: 'Favourites' });
    const names = within(favourites)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
    const spendingIdx = names.findIndex((n) => /Spending by Category/.test(n));
    const netWorthIdx = names.findIndex((n) => /Net Worth Over Time/.test(n));
    expect(spendingIdx).toBeGreaterThanOrEqual(0);
    expect(netWorthIdx).toBeGreaterThanOrEqual(0);
    expect(spendingIdx).toBeLessThan(netWorthIdx);
  });

  it('still filters a favourite by its own category name', async () => {
    setFavouriteReportIds(['savings-rate']);
    await openSwitcher('monthly-comparison');
    fireEvent.change(screen.getByPlaceholderText('Filter reports...'), {
      target: { value: 'budget' },
    });
    // Savings Rate sits in Favourites now, but its searchText still carries its
    // Budget category, so a category search finds it.
    const favourites = screen.getByRole('group', { name: 'Favourites' });
    expect(
      within(favourites).getByRole('menuitem', { name: /Savings Rate/ }),
    ).toBeInTheDocument();
  });
});
