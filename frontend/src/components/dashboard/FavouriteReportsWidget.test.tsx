import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { FavouriteReportsWidget } from './FavouriteReportsWidget';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const { prefsState } = vi.hoisted(() => ({
  prefsState: {
    current: { favouriteReportIds: [] as string[] },
  },
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: (s: unknown) => unknown) => {
    const state = { preferences: prefsState.current };
    return selector ? selector(state) : state;
  },
}));

const getCustomReportsMock = vi.fn();
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getAll: (...args: unknown[]) => getCustomReportsMock(...args),
  },
}));

const getInvestmentReportsMock = vi.fn();
vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: {
    getAll: (...args: unknown[]) => getInvestmentReportsMock(...args),
  },
}));

async function renderWidget(parentLoading = false) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<FavouriteReportsWidget isLoading={parentLoading} />);
  });
  return result!;
}

describe('FavouriteReportsWidget', () => {
  beforeEach(() => {
    pushMock.mockReset();
    getCustomReportsMock.mockReset().mockResolvedValue([]);
    getInvestmentReportsMock.mockReset().mockResolvedValue([]);
    prefsState.current = { favouriteReportIds: [] };
  });

  it('renders parent-loading skeleton without calling the APIs', async () => {
    await renderWidget(true);
    expect(getCustomReportsMock).not.toHaveBeenCalled();
    expect(getInvestmentReportsMock).not.toHaveBeenCalled();
    expect(screen.getByText('Favourite Reports')).toBeInTheDocument();
  });

  it('renders the empty state with a link to the Reports page', async () => {
    await renderWidget();
    expect(screen.getByText(/No favourite reports yet/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse reports'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reports');
  });

  it('lists built-in favourites in stored order and navigates on click', async () => {
    prefsState.current = { favouriteReportIds: ['net-worth', 'spending-by-category'] };
    await renderWidget();

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Net Worth Over Time');
    expect(items[1]).toHaveTextContent('Spending by Category');

    await act(async () => {
      fireEvent.click(screen.getByText('Net Worth Over Time'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('drops unknown built-in report ids', async () => {
    prefsState.current = { favouriteReportIds: ['no-longer-exists', 'net-worth'] };
    await renderWidget();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Net Worth Over Time')).toBeInTheDocument();
  });

  it('includes favourite custom and investment reports after built-ins', async () => {
    prefsState.current = { favouriteReportIds: ['net-worth'] };
    getCustomReportsMock.mockResolvedValue([
      { id: 'c1', name: 'My Custom Report', isFavourite: true, icon: null, backgroundColor: null },
      { id: 'c2', name: 'Not Starred', isFavourite: false, icon: null, backgroundColor: null },
    ]);
    getInvestmentReportsMock.mockResolvedValue([
      { id: 'i1', name: 'My Holdings', isFavourite: true, icon: null, backgroundColor: null },
    ]);
    await renderWidget();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Net Worth Over Time');
    expect(items[1]).toHaveTextContent('My Custom Report');
    expect(items[2]).toHaveTextContent('My Holdings');
    expect(screen.queryByText('Not Starred')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('My Custom Report'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reports/custom/c1');

    await act(async () => {
      fireEvent.click(screen.getByText('My Holdings'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reports/investment/i1');
  });

  it('still shows built-in favourites when the managed report APIs fail', async () => {
    prefsState.current = { favouriteReportIds: ['net-worth'] };
    getCustomReportsMock.mockRejectedValue(new Error('boom'));
    getInvestmentReportsMock.mockRejectedValue(new Error('boom'));
    await renderWidget();
    expect(screen.getByText('Net Worth Over Time')).toBeInTheDocument();
  });

  it('navigates to the Reports page from the title', async () => {
    await renderWidget();
    await act(async () => {
      fireEvent.click(screen.getByText('Favourite Reports'));
    });
    expect(pushMock).toHaveBeenCalledWith('/reports');
  });
});
