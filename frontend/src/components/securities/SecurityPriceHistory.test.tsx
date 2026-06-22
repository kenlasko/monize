import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SecurityPriceHistory } from './SecurityPriceHistory';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityPrices: vi.fn(),
    createSecurityPrice: vi.fn(),
    updateSecurityPrice: vi.fn(),
    deleteSecurityPrice: vi.fn(),
    backfillSecurityPrices: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    dateFormat: 'browser',
  }),
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
    volume: 1000,
    source: 'manual',
    createdAt: '2025-05-29T10:00:00Z',
  },
];

describe('SecurityPriceHistory', () => {
  const onClose = vi.fn();

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
    window.addEventListener('unhandledrejection', swallowExpected);
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(mockPrices);
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', swallowExpected);
  });

  async function renderComponent() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<SecurityPriceHistory security={mockSecurity} onClose={onClose} />);
    });
    return result!;
  }

  it('renders price history with source badges', async () => {
    await renderComponent();

    expect(screen.getByText('AAPL - Price History')).toBeInTheDocument();
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

  it('calls onClose when close button clicked', async () => {
    await renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders edit and delete buttons for each row', async () => {
    await renderComponent();

    const editButtons = screen.getAllByText('Edit');
    const deleteButtons = screen.getAllByText('Delete');
    expect(editButtons).toHaveLength(3);
    expect(deleteButtons).toHaveLength(3);
  });

  it('loads prices on mount with the 9999 limit', async () => {
    await renderComponent();
    expect(investmentsApi.getSecurityPrices).toHaveBeenCalledWith('sec-1', 9999);
  });

  it('shows the loading spinner before prices resolve', () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );
    render(<SecurityPriceHistory security={mockSecurity} onClose={onClose} />);
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
    await renderComponent();
    expect(screen.getByText('MSN')).toBeInTheDocument();
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Reinvest')).toBeInTheDocument();
    expect(screen.getByText('Transfer In')).toBeInTheDocument();
    expect(screen.getByText('Transfer Out')).toBeInTheDocument();
    expect(screen.getByText('made_up_provider')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
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
    expect(screen.getByLabelText('Close Price')).toHaveValue(193.5);

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
    await renderComponent();

    fireEvent.click(screen.getAllByText('Delete')[0]);
    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    });
    await act(async () => {});

    expect(toast.error).toHaveBeenCalledWith('Failed to delete price');
    expect(screen.getAllByText('Edit')).toHaveLength(3);
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
});
