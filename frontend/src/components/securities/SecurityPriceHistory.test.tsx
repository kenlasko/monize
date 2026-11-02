import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SecurityPriceHistory } from './SecurityPriceHistory';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityPrices: vi.fn(),
    // Kept mocked although this pane no longer calls it, so the guard test
    // below can assert that it stays uncalled.
    getSecurityTransactionHistory: vi.fn(),
    createSecurityPrice: vi.fn(),
    updateSecurityPrice: vi.fn(),
    deleteSecurityPrice: vi.fn(),
    backfillSecurityPrices: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    formatMonth: (m: string) => m,
    dateFormat: 'browser',
    datePattern: 'YYYY-MM-DD',
  }),
}));

// Pin "today" so the "add another year" range is computed deterministically.
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2026-08-14',
}));

const { investmentsApi } = await import('@/lib/investments');

const mockSecurity = {
  id: 'sec-1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
  isActive: true,
  isFavourite: false,
  skipPriceUpdates: false,
  sector: null,
  industry: null,
  sectorWeightings: null,
  countryWeightings: null,
  assetWeightings: null,
    website: null,
    irWebsite: null,
    quoteProvider: null,
    msnInstrumentId: null,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const mockPrices = [
  {
    id: 1,
    securityId: 'sec-1',
    priceDate: '2025-06-01',
    openPrice: 190,
    highPrice: 195,
    lowPrice: 189,
    closePrice: 193.5,
    adjustedClose: 191.2,
    volume: 50000000,
    source: 'yahoo_finance',
    createdAt: '2025-06-01T17:00:00Z',
  },
  {
    id: 2,
    securityId: 'sec-1',
    priceDate: '2025-05-30',
    openPrice: null,
    highPrice: null,
    lowPrice: null,
    closePrice: 150.25,
    adjustedClose: null,
    volume: null,
    source: 'buy',
    createdAt: '2025-05-30T10:00:00Z',
  },
  {
    id: 3,
    securityId: 'sec-1',
    priceDate: '2025-05-29',
    openPrice: 145,
    highPrice: 148,
    lowPrice: 144,
    closePrice: 147,
    adjustedClose: null,
    volume: 1000,
    source: 'manual',
    createdAt: '2025-05-29T10:00:00Z',
  },
];

/** `count` synthetic daily prices, newest first, as the API returns them. */
function manyPrices(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const month = 1 + Math.floor(i / 28);
    const day = 1 + (i % 28);
    return {
      id: 100 + i,
      securityId: 'sec-1',
      priceDate: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      openPrice: 100 + i,
      highPrice: 101 + i,
      lowPrice: 99 + i,
      closePrice: 100 + i,
      volume: 1000,
      source: 'yahoo_finance',
      createdAt: '2025-04-01T10:00:00Z',
    };
  });
}

/**
 * Controllable IntersectionObserver. The component tears its observer down and
 * rebuilds it on every batch, so only the most recent callback is live --
 * `scrollToEnd` always drives that one.
 */
type IntersectCallback = (entries: { isIntersecting: boolean }[]) => void;
const liveObservers: IntersectCallback[] = [];

vi.stubGlobal(
  'IntersectionObserver',
  vi.fn(function (this: Record<string, unknown>, callback: IntersectCallback) {
    this.observe = vi.fn(() => {
      liveObservers.push(callback);
    });
    this.unobserve = vi.fn();
    this.disconnect = vi.fn(() => {
      const index = liveObservers.indexOf(callback);
      if (index !== -1) liveObservers.splice(index, 1);
    });
  }),
);

describe('SecurityPriceHistory', () => {
  // The component intentionally rethrows from handleAdd/handleEdit so the real
  // SecurityPriceForm keeps its submitting state. react-hook-form's handleSubmit
  // surfaces that as a rejected promise the test never awaits, which vitest
  // would flag as an unhandled rejection. Swallow the expected test errors.
  const swallowExpected = (event: PromiseRejectionEvent) => {
    const msg = (event.reason as Error)?.message;
    if (msg === 'nope' || msg === 'boom') {
      event.preventDefault();
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    liveObservers.length = 0;
    window.addEventListener('unhandledrejection', swallowExpected);
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(mockPrices);
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', swallowExpected);
  });

  async function renderComponent(onPricesChanged?: () => void) {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <SecurityPriceHistory
          security={mockSecurity}
          onPricesChanged={onPricesChanged}
        />,
      );
    });
    return result!;
  }

  /**
   * Render with every year and month unfolded. Only the newest month opens by
   * itself, so any test about the rows themselves has to ask for the rest.
   */
  async function renderExpanded() {
    const result = await renderComponent();
    const expand = screen.queryByRole('button', { name: 'Expand all' });
    // Absent when a single month holds everything: it is open already, and the
    // button reads "Collapse all".
    if (expand) {
      await act(async () => {
        fireEvent.click(expand);
      });
    }
    return result;
  }

  it('renders price history with source badges', async () => {
    await renderExpanded();

    expect(screen.getByText('Yahoo')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('shows empty state when no prices', async () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await renderComponent();

    expect(screen.getByText('No price history available')).toBeInTheDocument();
  });

  it('shows add price form when button clicked', async () => {
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add Price'));
    });

    // "Add Price" appears as both the section header and form button
    expect(screen.getAllByText('Add Price').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('Close Price')).toBeInTheDocument();
  });

  it('renders only the price pane, leaving the heading and chart to the detail page', async () => {
    // Regression guard: this pane used to be a modal opened from the securities
    // list, with its own heading, Close button and chart. The detail page draws
    // the header and the chart itself, and the trade lookup existed only to mark
    // up that chart -- so a request for it here is dead weight on every visit.
    await renderComponent();

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.queryByText('Price History')).not.toBeInTheDocument();
    expect(investmentsApi.getSecurityTransactionHistory).not.toHaveBeenCalled();
  });

  it('shows the adjusted close, and a dash where the provider gives none', async () => {
    await renderExpanded();

    // One header per open month, so the column appears once per month.
    expect(screen.getAllByText('Adj. close').length).toBeGreaterThan(0);
    // The Yahoo row has the total-return close...
    expect(screen.getByText('191.20')).toBeInTheDocument();
    // ...and a dash on the rows without one is the only way to notice that a
    // provider (MSN) supplies no total-return series at all.
    const manualRow = screen.getByText('147.00').closest('tr')!;
    expect(manualRow.textContent).toContain('-');
  });

  it('renders edit and delete buttons for each row', async () => {
    await renderExpanded();

    const editButtons = screen.getAllByText('Edit');
    const deleteButtons = screen.getAllByText('Delete');
    expect(editButtons).toHaveLength(3);
    expect(deleteButtons).toHaveLength(3);
  });

  it('loads prices on mount with the 9999 limit', async () => {
    await renderComponent();
    expect(investmentsApi.getSecurityPrices).toHaveBeenCalledWith('sec-1', {
      limit: 9999,
    });
  });

  it('shows the loading spinner before prices resolve', () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    render(<SecurityPriceHistory security={mockSecurity} />);
    expect(screen.getByText('Loading prices...')).toBeInTheDocument();
  });

  it('shows an error toast and the empty state when loading prices fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    // A non-Error rejection makes getErrorMessage fall back to the default text.
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockRejectedValue(
      'boom',
    );
    await renderComponent();
    await act(async () => {});
    expect(toast.error).toHaveBeenCalledWith('Failed to load price history');
    expect(screen.getByText('No price history available')).toBeInTheDocument();
  });

  it('renders a translated label, not the raw id, for a bond engine price', async () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 30, securityId: 'sec-1', priceDate: '2025-06-10', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'bond_engine', createdAt: 'x' },
    ]);
    await renderExpanded();
    expect(screen.getByText('Bond engine')).toBeInTheDocument();
    expect(screen.queryByText('bond_engine')).not.toBeInTheDocument();
  });

  it('renders all source label variants including unknowns', async () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 10, securityId: 'sec-1', priceDate: '2025-06-10', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'msn_finance', createdAt: 'x' },
      { id: 11, securityId: 'sec-1', priceDate: '2025-06-11', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'sell', createdAt: 'x' },
      { id: 12, securityId: 'sec-1', priceDate: '2025-06-12', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'reinvest', createdAt: 'x' },
      { id: 13, securityId: 'sec-1', priceDate: '2025-06-13', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'transfer_in', createdAt: 'x' },
      { id: 14, securityId: 'sec-1', priceDate: '2025-06-14', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'transfer_out', createdAt: 'x' },
      { id: 15, securityId: 'sec-1', priceDate: '2025-06-15', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'made_up_provider', createdAt: 'x' },
      { id: 16, securityId: 'sec-1', priceDate: '2025-06-16', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: null, createdAt: 'x' },
    ]);
    await renderExpanded();
    expect(screen.getByText('MSN')).toBeInTheDocument();
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Reinvest')).toBeInTheDocument();
    expect(screen.getByText('Transfer In')).toBeInTheDocument();
    expect(screen.getByText('Transfer Out')).toBeInTheDocument();
    expect(screen.getByText('made_up_provider')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('names every provider source as the securities list does, never by its raw id', async () => {
    // This pane once kept its own label table, which knew Yahoo and MSN only, so
    // LSE, Deutsche Börse and web-page-table prices showed as "lse",
    // "deutsche_boerse" and "html_table".
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 20, securityId: 'sec-1', priceDate: '2025-06-10', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'lse', createdAt: 'x' },
      { id: 21, securityId: 'sec-1', priceDate: '2025-06-11', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'deutsche_boerse', createdAt: 'x' },
      { id: 22, securityId: 'sec-1', priceDate: '2025-06-12', openPrice: null, highPrice: null, lowPrice: null, closePrice: 1, volume: null, source: 'html_table', createdAt: 'x' },
    ]);
    await renderExpanded();
    expect(screen.getByText('LSE')).toBeInTheDocument();
    expect(screen.getByText('Deutsche Börse')).toBeInTheDocument();
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.queryByText('html_table')).not.toBeInTheDocument();
  });

  it('hides the Add Price button while the add form is open and reopens it on cancel', async () => {
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add Price'));
    });
    expect(screen.queryByText('+ Add Price')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.getByText('+ Add Price')).toBeInTheDocument();
  });

  it('creates a price, shows a success toast, closes the form, and reloads', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.createSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPrices[0],
    );
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add Price'));
    });
    fireEvent.change(screen.getByLabelText('Close Price'), {
      target: { value: '15.5' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Price' }));
    });

    expect(investmentsApi.createSecurityPrice).toHaveBeenCalledWith(
      'sec-1',
      expect.objectContaining({ closePrice: 15.5 }),
    );
    expect(toast.success).toHaveBeenCalledWith('Price added');
    expect(screen.queryByLabelText('Close Price')).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the add form open when create fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.createSecurityPrice as ReturnType<typeof vi.fn>).mockRejectedValue(
      'nope',
    );
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add Price'));
    });
    fireEvent.change(screen.getByLabelText('Close Price'), {
      target: { value: '15.5' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Price' }));
    });
    await act(async () => {});

    expect(toast.error).toHaveBeenCalledWith('Failed to add price');
    // Form remains open and no reload happened.
    expect(screen.getByLabelText('Close Price')).toBeInTheDocument();
    expect(investmentsApi.getSecurityPrices).toHaveBeenCalledTimes(1);
  });

  it('opens the edit form prefilled and updates the price', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.updateSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPrices[0],
    );
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0]);
    });
    expect(screen.getByText('Edit Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Close Price')).toHaveValue('193.500000');

    fireEvent.change(screen.getByLabelText('Close Price'), {
      target: { value: '200' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update Price' }));
    });

    expect(investmentsApi.updateSecurityPrice).toHaveBeenCalledWith(
      'sec-1',
      1,
      expect.objectContaining({ closePrice: 200 }),
    );
    expect(toast.success).toHaveBeenCalledWith('Price updated');
  });

  it('shows an error toast and keeps the edit form open when update fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.updateSecurityPrice as ReturnType<typeof vi.fn>).mockRejectedValue(
      'nope',
    );
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0]);
    });
    fireEvent.change(screen.getByLabelText('Close Price'), {
      target: { value: '200' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update Price' }));
    });
    await act(async () => {});

    expect(toast.error).toHaveBeenCalledWith('Failed to update price');
    expect(screen.getByText('Edit Price')).toBeInTheDocument();
  });

  it('cancels the edit form via its Cancel button', async () => {
    await renderComponent();
    await act(async () => {
      fireEvent.click(screen.getAllByText('Edit')[0]);
    });
    expect(screen.getByText('Edit Price')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByText('Edit Price')).not.toBeInTheDocument();
  });

  it('deletes a price after confirmation and reloads', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.deleteSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    await renderComponent();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    // The ConfirmDialog adds a second "Delete" action button.
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });

    expect(investmentsApi.deleteSecurityPrice).toHaveBeenCalledWith('sec-1', 1);
    expect(toast.success).toHaveBeenCalledWith('Price deleted');
  });

  it('names the row being deleted in the confirm dialog', async () => {
    await renderComponent();

    fireEvent.click(screen.getAllByText('Delete')[0]);

    expect(screen.getByText('Delete price entry for 2025-06-01?')).toBeInTheDocument();
  });

  it('does not delete when the confirm dialog is cancelled', async () => {
    await renderComponent();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(investmentsApi.deleteSecurityPrice).not.toHaveBeenCalled();
  });

  it('shows an error toast and keeps the table rendered when delete fails', async () => {
    const toast = (await import('react-hot-toast')).default;
    (investmentsApi.deleteSecurityPrice as ReturnType<typeof vi.fn>).mockRejectedValue(
      'boom',
    );
    await renderExpanded();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });
    await act(async () => {});

    expect(toast.error).toHaveBeenCalledWith('Failed to delete price');
    expect(screen.getAllByText('Edit')).toHaveLength(3);
  });

  describe('grouping the price table by year and month', () => {
    const rowCount = () => document.querySelectorAll('tbody tr').length;

    it('opens the newest year and month, and folds the rest', async () => {
      (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(
        manyPrices(75),
      );
      await renderComponent();

      // 75 rows spread over Jan-Mar 2025; only March is open, so only its rows
      // are mounted. A flat table of a decade of closes cannot be navigated to
      // March 2023 except by scrolling past everything after it.
      // Reached through its own label rather than the button's computed name:
      // adjacent spans give no whitespace between the year and its count.
      expect(screen.getByText('2025').closest('button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(rowCount()).toBeLessThan(75);
      expect(rowCount()).toBeGreaterThan(0);
    });

    it('mounts a month\'s rows only once it is opened', async () => {
      (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(
        manyPrices(75),
      );
      await renderComponent();
      const before = rowCount();

      // 2025-01 is folded on arrival.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /2025-01/ }));
      });
      expect(rowCount()).toBeGreaterThan(before);
    });

    it('expands everything, then collapses everything', async () => {
      (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(
        manyPrices(75),
      );
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
      });
      expect(rowCount()).toBe(75);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
      });
      expect(rowCount()).toBe(0);
    });

    it('states how many prices a folded group holds', async () => {
      (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(
        manyPrices(75),
      );
      await renderComponent();

      // The year says its size without being opened.
      expect(screen.getByText('75 price(s)')).toBeInTheDocument();
    });

  });

  describe('mobile long-press actions', () => {
    // The actions column is CSS-hidden below the sm breakpoint, so on a phone
    // the row's only route to edit/delete is a press-and-hold.
    async function longPressFirstRow() {
      const row = screen.getByText('2025-06-01').closest('tr')!;
      fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
      await act(async () => {
        await new Promise((res) => setTimeout(res, 800));
      });
      return row;
    }

    it('hides the actions column on mobile and keeps it from the sm breakpoint up', async () => {
      await renderComponent();

      const header = screen.getByRole('columnheader', { name: 'Actions' });
      expect(header.className).toContain('hidden');
      expect(header.className).toContain('sm:table-cell');

      const actionCell = screen.getAllByText('Edit')[0].closest('td')!;
      expect(actionCell.className).toContain('hidden');
      expect(actionCell.className).toContain('sm:table-cell');
    });

    it('opens the action sheet on long-press, headed by the row date and close price', async () => {
      await renderExpanded();
      await longPressFirstRow();

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Sheet heading: the pressed row's date, subtitled with its close price.
      // Both also appear in the table row, hence the duplicate counts.
      const sheet = screen.getByRole('dialog');
      expect(sheet.textContent).toContain('2025-06-01');
      expect(sheet.textContent).toContain('193.50');
    });

    it('does not open the sheet when the touch moves beyond the drag threshold', async () => {
      await renderExpanded();

      const row = screen.getByText('2025-06-01').closest('tr')!;
      fireEvent.touchStart(row, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.touchMove(row, { touches: [{ clientX: 50, clientY: 50 }] });
      await act(async () => {
        await new Promise((res) => setTimeout(res, 800));
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens the edit form from the action sheet', async () => {
      await renderExpanded();
      await longPressFirstRow();

      const sheetEdit = screen.getAllByRole('button', { name: 'Edit' }).at(-1)!;
      await act(async () => {
        fireEvent.click(sheetEdit);
      });

      expect(screen.getByText('Edit Price')).toBeInTheDocument();
    });

    it('deletes a price from the action sheet after confirmation', async () => {
      (investmentsApi.deleteSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );
      await renderExpanded();
      await longPressFirstRow();

      const sheetDelete = screen.getAllByRole('button', { name: 'Delete' }).at(-1)!;
      await act(async () => {
        fireEvent.click(sheetDelete);
      });

      const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
      await act(async () => {
        fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      });

      expect(investmentsApi.deleteSecurityPrice).toHaveBeenCalledWith('sec-1', 1);
    });
  });

  describe('Force Update Prices', () => {
    it('force-updates prices, shows a success toast with the count, and reloads', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: true,
        pricesLoaded: 252,
        provider: 'yahoo',
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(investmentsApi.backfillSecurityPrices).toHaveBeenCalledWith('sec-1');
      expect(toast.success).toHaveBeenCalledWith('Updated 252 prices for AAPL');
      // Reloaded after the update (initial mount + post-update).
      expect(investmentsApi.getSecurityPrices).toHaveBeenCalledTimes(2);
    });

    it('uses singular wording when exactly one price is loaded', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: true,
        pricesLoaded: 1,
        provider: 'yahoo',
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(toast.success).toHaveBeenCalledWith('Updated 1 price for AAPL');
    });

    it('shows a "no prices found" toast when zero prices are loaded', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: true,
        pricesLoaded: 0,
        provider: 'yahoo',
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(toast.success).toHaveBeenCalledWith('No prices found for AAPL');
    });

    it('shows the backend error message when the update reports failure', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: false,
        error: 'No historical data available',
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(toast.error).toHaveBeenCalledWith('No historical data available');
      // No reload on failure (only the initial mount load).
      expect(investmentsApi.getSecurityPrices).toHaveBeenCalledTimes(1);
    });

    it('falls back to a generic message when failure has no error string', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: false,
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(toast.error).toHaveBeenCalledWith('Failed to update prices for AAPL');
    });

    it('shows an error toast when the request throws', async () => {
      const toast = (await import('react-hot-toast')).default;
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockRejectedValue(
        'boom',
      );
      await renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });
      await act(async () => {});

      expect(toast.error).toHaveBeenCalledWith('Failed to update prices');
    });
  });

  // The detail page's chart and quote card hold their own copy of the price
  // series, fetched once on load -- this pane changing the stored rows must
  // tell the page to reload its copy too, or the chart keeps showing the
  // pre-update line until the reader presses the page's separate refresh
  // button (a different control, easy to miss the connection to).
  describe('onPricesChanged', () => {
    it('notifies the parent after a successful force update', async () => {
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: true,
        pricesLoaded: 252,
        provider: 'yahoo',
      });
      const onPricesChanged = vi.fn();
      await renderComponent(onPricesChanged);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(onPricesChanged).toHaveBeenCalledTimes(1);
    });

    it('does not notify the parent when the force update reports failure', async () => {
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: false,
        error: 'No historical data available',
      });
      const onPricesChanged = vi.fn();
      await renderComponent(onPricesChanged);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });

      expect(onPricesChanged).not.toHaveBeenCalled();
    });

    it('does not notify the parent when the force update request throws', async () => {
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockRejectedValue(
        'boom',
      );
      const onPricesChanged = vi.fn();
      await renderComponent(onPricesChanged);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Force Update Prices' }));
      });
      await act(async () => {});

      expect(onPricesChanged).not.toHaveBeenCalled();
    });

    it('notifies the parent after adding a price', async () => {
      (investmentsApi.createSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockPrices[0],
      );
      const onPricesChanged = vi.fn();
      await renderComponent(onPricesChanged);

      await act(async () => {
        fireEvent.click(screen.getByText('+ Add Price'));
      });
      fireEvent.change(screen.getByLabelText('Close Price'), {
        target: { value: '15.5' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add Price' }));
      });

      expect(onPricesChanged).toHaveBeenCalledTimes(1);
    });

    it('notifies the parent after deleting a price', async () => {
      (investmentsApi.deleteSecurityPrice as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );
      const onPricesChanged = vi.fn();
      await renderComponent(onPricesChanged);

      fireEvent.click(screen.getAllByText('Delete')[0]);
      const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
      await act(async () => {
        fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      });

      expect(onPricesChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('Add Another Year of History', () => {
    it('backfills the next range deeper than the loaded history and reloads', async () => {
      const toast = (await import('react-hot-toast')).default;
      // One stored close from 2024-06-01; against the pinned "today" of
      // 2026-08-14 that is roughly two years, so one year more asks the
      // provider for 5y (the next bucket up), which also disables the
      // holding-period clip so history from before the first trade is kept.
      (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          securityId: 'sec-1',
          priceDate: '2024-06-01',
          openPrice: null,
          highPrice: null,
          lowPrice: null,
          closePrice: 100,
          volume: null,
          source: 'yahoo_finance',
          createdAt: 'x',
        },
      ]);
      (investmentsApi.backfillSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue({
        symbol: 'AAPL',
        success: true,
        pricesLoaded: 300,
        provider: 'yahoo',
      });
      await renderComponent();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Add Another Year of History' }),
        );
      });

      expect(investmentsApi.backfillSecurityPrices).toHaveBeenCalledWith(
        'sec-1',
        '5y',
      );
      expect(toast.success).toHaveBeenCalledWith('Updated 300 prices for AAPL');
      // Reloaded after the fetch (initial mount + post-fetch).
      expect(investmentsApi.getSecurityPrices).toHaveBeenCalledTimes(2);
    });
  });
});
