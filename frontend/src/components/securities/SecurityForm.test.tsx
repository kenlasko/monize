import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { SecurityForm } from './SecurityForm';
import { Security } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi } from '@/lib/exchange-rates';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => {
    const errors: any = {};
    if (!values.symbol || values.symbol.trim() === '') {
      errors.symbol = { type: 'required', message: 'Symbol is required' };
    }
    if (!values.name || values.name.trim() === '') {
      errors.name = { type: 'required', message: 'Name is required' };
    }
    if (!values.currencyCode || values.currencyCode.trim() === '') {
      errors.currencyCode = { type: 'required', message: 'Currency is required' };
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors };
    }
    return { values, errors: {} };
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    lookupSecurity: vi.fn().mockResolvedValue(null),
    lookupSecurityCandidates: vi.fn().mockResolvedValue([]),
    getProviderStatus: vi.fn().mockResolvedValue({
      yahoo: { ready: true },
      msn: { ready: true },
    }),
    getSuggestedDescription: vi
      .fn()
      .mockResolvedValue({ symbol: 'AAPL', description: null }),
  },
}));

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'tag-1', userId: 'u1', name: 'AI', color: '#abcdef', icon: null, createdAt: '', updatedAt: '' },
      { id: 'tag-2', userId: 'u1', name: 'Bonds', color: null, icon: null, createdAt: '', updatedAt: '' },
    ]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true },
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true },
    ]),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

function createSecurity(overrides: Partial<Security> = {}): Security {
  return {
    id: 's1',
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
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SecurityForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders create form fields', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Symbol')).toBeInTheDocument();
    });
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('shows Create Security button for new form', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Create Security')).toBeInTheDocument();
    });
  });

  it('shows Update Security button when editing', async () => {
    const security = createSecurity();
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Update Security')).toBeInTheDocument();
    });
  });

  it('calls onCancel when cancel is clicked', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalled();
    });
  });

  // --- New tests for improved coverage ---

  it('populates form with security data when editing', async () => {
    const security = createSecurity({
      symbol: 'XEQT',
      name: 'iShares Core Equity ETF',
      securityType: 'ETF',
      exchange: 'TSX',
      currencyCode: 'CAD',
    });

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('XEQT')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('iShares Core Equity ETF')).toBeInTheDocument();
  });

  it('shows the security\'s own currency when editing, not the user base currency', async () => {
    // Base currency is CAD (useNumberFormat mock); this security is in USD.
    // Currencies load asynchronously, so the controlled select must still
    // reflect the security's value once the options arrive (regression test).
    const security = createSecurity({ currencyCode: 'USD' });

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

    await waitFor(() => {
      expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
    });
    await waitFor(() => {
      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      expect(currencySelect.value).toBe('USD');
    });
  });

  it('shows Lookup button for new security form', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Lookup')).toBeInTheDocument();
    });
  });

  it('shows Lookup button when editing existing security', async () => {
    const security = createSecurity();
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Lookup')).toBeInTheDocument();
    });
  });

  it('auto-sets the Quote Provider override when the lookup resolves via a non-default provider', async () => {
    // User default is "yahoo" (from the preferences store mock).
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'RBF556',
      name: 'RBC Canadian Equity Fund',
      exchange: 'TSX',
      securityType: 'MUTUAL_FUND',
      currencyCode: 'CAD',
      provider: 'msn',
      msnInstrumentId: 'msn-rbf556',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'RBF556' } });
    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      // Quote Provider select should have been updated to MSN Money.
      const providerSelect = screen.getByLabelText('Quote Provider') as HTMLSelectElement;
      expect(providerSelect.value).toBe('msn');
    });

    // MSN Instrument ID field is rendered when provider is MSN and should
    // be pre-populated from the lookup.
    await waitFor(() => {
      expect(screen.getByDisplayValue('msn-rbf556')).toBeInTheDocument();
    });
  });

  it('does NOT set the override when the lookup resolves via the default provider', async () => {
    // User default is "yahoo"; the lookup also came from Yahoo.
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
      provider: 'yahoo',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });
    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(investmentsApi.lookupSecurityCandidates).toHaveBeenCalled();
    });

    const providerSelect = screen.getByLabelText('Quote Provider') as HTMLSelectElement;
    expect(providerSelect.value).toBe('');
  });

  it('uses "Revert" label (not "Clear") when editing after a successful lookup', async () => {
    const security = createSecurity({ symbol: 'AAPL' });
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    }]);

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(screen.getByText('Revert')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clear')).not.toBeInTheDocument();
  });

  it('renders security type options', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    const options = Array.from(typeSelect.querySelectorAll('option'));
    const optionValues = options.map(o => o.value);

    await waitFor(() => {
      expect(optionValues).toContain('STOCK');
    });
    expect(optionValues).toContain('ETF');
    expect(optionValues).toContain('MUTUAL_FUND');
    expect(optionValues).toContain('BOND');
    expect(optionValues).toContain('OPTION');
    expect(optionValues).toContain('CRYPTO');
    expect(optionValues).toContain('OTHER');
  });

  it('renders security type option labels', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    const options = Array.from(typeSelect.querySelectorAll('option'));
    const optionTexts = options.map(o => o.textContent);

    await waitFor(() => {
      expect(optionTexts).toContain('Stock');
    });
    expect(optionTexts).toContain('ETF');
    expect(optionTexts).toContain('Mutual Fund');
    expect(optionTexts).toContain('Bond');
    expect(optionTexts).toContain('Cryptocurrency');
  });

  it('shows placeholder text for symbol input', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g., AAPL, XEQT, BTC')).toBeInTheDocument();
    });
  });

  it('shows placeholder text for name input', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('e.g., Apple Inc., iShares Core Equity ETF')).toBeInTheDocument();
    });
  });

  it('shows placeholder text for exchange input', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search exchanges...')).toBeInTheDocument();
    });
  });

  it('loads currencies on mount', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    await waitFor(() => {
      expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
    });
  });

  it('submits form with valid data', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    const nameInput = screen.getByLabelText('Name');

    fireEvent.change(symbolInput, { target: { value: 'MSFT' } });
    fireEvent.change(nameInput, { target: { value: 'Microsoft Corporation' } });

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
  });

  it('defaults a new security to not favourite and can toggle it on before submit', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'MSFT' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Microsoft Corporation' } });

    // Star starts as "Add to favourites"; click it to mark favourite.
    fireEvent.click(screen.getByTitle('Add to favourites'));
    expect(screen.getByTitle('Remove from favourites')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ isFavourite: true }));
    });
  });

  it('shows an existing favourite security as already starred', async () => {
    const security = createSecurity({ isFavourite: true });
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByTitle('Remove from favourites')).toBeInTheDocument();
    // Flush the async state update on mount so it is wrapped in act().
    await act(async () => {});
  });

  it('shows validation error when symbol is empty', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    // Clear symbol and submit
    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: '' } });

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(screen.getByText('Symbol is required')).toBeInTheDocument();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows validation error when name is empty', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    // Fill symbol but not name
    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'MSFT' } });

    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: '' } });

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('performs security lookup when Lookup button is clicked', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(investmentsApi.lookupSecurityCandidates).toHaveBeenCalledWith('AAPL', undefined, 'auto');
    });

    // After successful lookup, Clear button should appear
    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });
  });

  it('shows Clear button after successful lookup and clears on click', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    // Click clear
    fireEvent.click(screen.getByText('Clear'));

    // Clear button should disappear after clearing
    await waitFor(() => {
      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
    });
  });

  it('shows a spinner (button stays same size) during lookup', async () => {
    let resolvePromise: (value: any) => void;
    const lookupPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockReturnValueOnce(lookupPromise);

    const { container } = render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    // The "Lookup" label is still rendered (as an invisible span that
    // preserves the button's width) and the spinning circle overlays it.
    await waitFor(() => {
      expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    });
    // Button should also not be showing the old "Looking up..." text.
    expect(screen.queryByText('Looking up...')).not.toBeInTheDocument();

    // Resolve the promise — spinner should disappear.
    resolvePromise!(null);
    await waitFor(() => {
      expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Lookup')).toBeInTheDocument();
  });

  it('calls onDirtyChange when form becomes dirty', async () => {
    const mockOnDirtyChange = vi.fn();

    render(
      <SecurityForm onSubmit={onSubmit} onCancel={onCancel} onDirtyChange={mockOnDirtyChange} />
    );

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'MSFT' } });

    await waitFor(() => {
      expect(mockOnDirtyChange).toHaveBeenCalledWith(true);
    });
  });

  it('prefills default currency when creating new security', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    // The currency select should be present (currency options loaded asynchronously)
    await waitFor(() => {
      const currencyLabel = screen.getByText('Currency');
      expect(currencyLabel).toBeInTheDocument();
    });
  });

  it('selects "Select type..." as default security type for new form', async () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    await waitFor(() => {
      const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
      expect(typeSelect.value).toBe('');
    });
  });

  it('populates security type when editing', async () => {
    const security = createSecurity({ securityType: 'ETF' });

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

    await waitFor(() => {
      const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
      expect(typeSelect.value).toBe('ETF');
    });
  });

  it('populates security type from lookup result', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'XEQT',
      name: 'iShares Core Equity ETF',
      exchange: 'TSX',
      securityType: 'ETF',
      currencyCode: 'CAD',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'XEQT' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
      expect(typeSelect.value).toBe('ETF');
    });
  });

  it('populates security type as STOCK from lookup for equities', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
      expect(typeSelect.value).toBe('STOCK');
    });
  });

  it('defaults type to empty when lookup returns null securityType', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'XYZ',
      name: 'Some Security',
      exchange: null,
      securityType: null,
      currencyCode: null,
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'XYZ' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    expect(typeSelect.value).toBe('');
  });

  it('lookup falls back to name field when symbol is empty', async () => {
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    }]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Apple Inc' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(investmentsApi.lookupSecurityCandidates).toHaveBeenCalledWith('Apple Inc', undefined, 'auto');
    });
  });

  describe('description and tags', () => {
    it('renders the description field and tag picker', async () => {
      render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Description')).toBeInTheDocument();
      });
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });

    it('populates the description from the provider during Lookup', async () => {
      (investmentsApi.lookupSecurityCandidates as any).mockResolvedValue([
        {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          exchange: 'NASDAQ',
          securityType: 'STOCK',
          currencyCode: 'USD',
          provider: 'yahoo',
          msnInstrumentId: null,
        },
      ]);
      (investmentsApi.getSuggestedDescription as any).mockResolvedValue({
        symbol: 'AAPL',
        description: 'Apple Inc. designs smartphones.',
      });
      render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

      fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AAPL' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Lookup'));
      });

      await waitFor(() => {
        expect(investmentsApi.getSuggestedDescription).toHaveBeenCalledWith('AAPL', 'NASDAQ');
      });
      const textarea = screen.getByPlaceholderText(
        'Notes about this security.',
      ) as HTMLTextAreaElement;
      await waitFor(() => {
        expect(textarea.value).toBe('Apple Inc. designs smartphones.');
      });
    });

    it('submits the description and tag IDs', async () => {
      render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

      fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'MSFT' } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Microsoft' } });
      fireEvent.change(
        screen.getByPlaceholderText(
          'Notes about this security.',
        ),
        { target: { value: 'A software company.' } },
      );

      fireEvent.click(screen.getByText('Create Security'));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'A software company.',
            tagIds: [],
          }),
        );
      });
    });

    it('pre-fills description and selected tags when editing', async () => {
      const security = createSecurity({
        description: 'Existing notes.',
        tags: [
          { id: 'tag-1', userId: 'u1', name: 'AI', color: '#abcdef', icon: null, createdAt: '', updatedAt: '' },
        ],
      });
      render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

      await waitFor(() => {
        const textarea = screen.getByPlaceholderText(
          'Notes about this security.',
        ) as HTMLTextAreaElement;
        expect(textarea.value).toBe('Existing notes.');
      });

      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ tagIds: ['tag-1'] }),
        );
      });
    });
  });

  describe('country allocation', () => {
    it('hides the country allocation editor for non-fund securities', async () => {
      const stock = createSecurity({ securityType: 'STOCK' });
      render(<SecurityForm security={stock} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByDisplayValue('AAPL')).toBeInTheDocument();
      });
      expect(screen.queryByText('Country allocation')).not.toBeInTheDocument();
    });

    it('shows and prefills the country allocation editor for an ETF', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        countryWeightings: [
          { name: 'United States', weight: 0.6 },
          { name: 'Canada', weight: 0.25 },
        ],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Country allocation')).toBeInTheDocument();
      });
      // Stored decimals are shown as percentages.
      expect(screen.getByDisplayValue('60')).toBeInTheDocument();
      expect(screen.getByDisplayValue('25')).toBeInTheDocument();
    });

    it('submits the country allocation back as decimals (0-1)', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        countryWeightings: [{ name: 'United States', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Country allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Update Security'));
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            countryWeightings: [{ name: 'United States', weight: 0.6 }],
          }),
        );
      });
    });
  });
});
