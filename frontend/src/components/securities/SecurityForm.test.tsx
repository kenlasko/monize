import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { SecurityForm } from './SecurityForm';
import { Security } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import toast from 'react-hot-toast';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'CAD' }),
  };
});
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
    getCountryOptions: vi
      .fn()
      .mockResolvedValue(['United States', 'Canada']),
    getAssetOptions: vi.fn().mockResolvedValue(['Cash', 'Equity']),
    listBondPrograms: vi.fn().mockResolvedValue([]),
    deleteAssetOption: vi
      .fn()
      .mockResolvedValue({ name: 'Equity', removedFrom: 1 }),
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
    assetWeightings: null,
    website: null,
    irWebsite: null,
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

  it.each(['5', ''])('saves or clears a security price threshold (%s)', async (value) => {
    render(<SecurityForm security={createSecurity({ priceAlertPercent: 10 })} onSubmit={onSubmit} onCancel={onCancel} />);
    const input = await screen.findByLabelText('Price change alert (%)');
    // A text input formatted by `NumericInput`, not a native number one, at the
    // column's own scale: NUMERIC(9,4), so four decimals in the reader's number
    // locale. Fewer would DISPLAY a stored 0.1250 as 0.13 and commit that on
    // the next blur (`ui-conventions.test.ts` bans the native control).
    expect(input).toHaveValue('10.0000');
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      priceAlertPercent: value ? 5 : null,
    })));
  });

  it.each([false, true])('saves an explicit chart opt-in (initial %s)', async (enabled) => {
    render(<SecurityForm security={createSecurity({ priceChartEnabled: enabled })} onSubmit={onSubmit} onCancel={onCancel} />);
    const toggle = await screen.findByRole('switch', { name: 'Include a chart in price alerts' });
    expect(toggle).toHaveAttribute('aria-checked', String(enabled));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({priceChartEnabled: !enabled})));
  });

  it.each([false, true])('saves a changed price-update switch (initial %s)', async (skipped) => {
    render(<SecurityForm security={createSecurity({ skipPriceUpdates: skipped })} onSubmit={onSubmit} onCancel={onCancel} />);
    const toggle = await screen.findByRole('switch', { name: 'Disable automatic price updates' });
    expect(toggle).toHaveAttribute('aria-checked', String(skipped));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ skipPriceUpdates: !skipped })));
  });

  // Left untouched, the switch is not sent, so the backend's rule applies: a
  // newly chosen provider turns updates back on for a flagged security.
  // The toggle shows what the save will store: the backend clears the flag
  // when a new provider is picked, so the form switches it off, and still omits it.
  it('unticks the switch when a new quote provider is picked', async () => {
    render(<SecurityForm security={createSecurity({ skipPriceUpdates: true, quoteProvider: null })} onSubmit={onSubmit} onCancel={onCancel} />);
    const toggle = await screen.findByRole('switch', { name: 'Disable automatic price updates' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByLabelText('Quote Provider'), { target: { value: 'yahoo' } });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('skipPriceUpdates');
  });

  it('keeps a stored provider from unticking the switch', async () => {
    render(<SecurityForm security={createSecurity({ skipPriceUpdates: true, quoteProvider: 'msn' })} onSubmit={onSubmit} onCancel={onCancel} />);
    const toggle = await screen.findByRole('switch', { name: 'Disable automatic price updates' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  // Re-ticking after the provider change is back at the stored value, so RHF
  // calls it clean; it is still the user's explicit choice and must be sent.
  it('sends a switch re-ticked after a new provider is picked', async () => {
    render(<SecurityForm security={createSecurity({ skipPriceUpdates: true, quoteProvider: null })} onSubmit={onSubmit} onCancel={onCancel} />);
    const toggle = await screen.findByRole('switch', { name: 'Disable automatic price updates' });
    fireEvent.change(screen.getByLabelText('Quote Provider'), { target: { value: 'yahoo' } });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ skipPriceUpdates: true, quoteProvider: 'yahoo' })));
  });

  it('omits an untouched price-update switch', async () => {
    render(<SecurityForm security={createSecurity({ skipPriceUpdates: true })} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('skipPriceUpdates');
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

  it('keeps a looked-up currency the user has not configured', async () => {
    // The provider returns the listing currency, which need not be one of the
    // user's currencies in Tools. A <select> whose value has no <option>
    // renders blank, so the code would vanish from the field and be lost on
    // save; it stays in the list, labelled as not configured.
    (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          symbol: 'CSPX',
          name: 'iShares Core S&P 500 UCITS ETF',
          exchange: 'LSE',
          currencyCode: 'GBP',
          securityType: 'ETF',
        },
      ]);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    await waitFor(() => {
      expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Symbol'), {
        target: { value: 'CSPX' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });

    await waitFor(() => {
      const select = screen.getByLabelText('Currency') as HTMLSelectElement;
      expect(select.value).toBe('GBP');
    });
    expect(
      screen.getByRole('option', { name: 'GBP — not in your currencies' }),
    ).toBeInTheDocument();
  });

  describe('lookup candidate without a currency', () => {
    async function lookUp(candidate: Record<string, unknown>) {
      (investmentsApi.lookupSecurityCandidates as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([candidate]);
      render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Symbol'), {
          target: { value: String(candidate.symbol) },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Lookup'));
      });
    }

    const notReported =
      "The provider did not report this coin's currency. Choose the fiat currency it is quoted in.";

    it('clears the currency for a crypto candidate with none, asks for it, and blocks submit', async () => {
      await lookUp({
        symbol: 'BTC-USDT',
        name: 'Bitcoin USDT',
        exchange: 'CRYPTO',
        currencyCode: null,
        securityType: 'CRYPTO',
      });

      await waitFor(() => {
        expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe('');
      });
      expect(screen.getByText(notReported)).toBeInTheDocument();
      expect(screen.getByText('Currency is required')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Select currency...' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Create Security'));
      });
      await waitFor(() => {
        expect(screen.getAllByText('Currency is required').length).toBeGreaterThan(0);
      });
      expect(onSubmit).not.toHaveBeenCalled();

      // Choosing the fiat the coin is quoted in satisfies the rule and lifts the note.
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'USD' } });
      });
      expect(screen.queryByText(notReported)).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Select currency...' })).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Create Security'));
      });
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ symbol: 'BTC-USDT', currencyCode: 'USD' }),
        );
      });
    });

    it('still applies the currency of a crypto candidate that has one', async () => {
      await lookUp({
        symbol: 'BTC-USD',
        name: 'Bitcoin USD',
        exchange: 'CRYPTO',
        currencyCode: 'USD',
        securityType: 'CRYPTO',
      });

      await waitFor(() => {
        expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe('USD');
      });
      expect(screen.queryByText(notReported)).not.toBeInTheDocument();
    });

    it('keeps the default currency for a non-crypto candidate with none', async () => {
      await lookUp({
        symbol: 'XYZ',
        name: 'Some Security',
        exchange: null,
        currencyCode: null,
        securityType: 'STOCK',
      });

      await waitFor(() => {
        expect(screen.getByText('Clear')).toBeInTheDocument();
      });
      expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe('CAD');
      expect(screen.queryByText(notReported)).not.toBeInTheDocument();
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
      expect(screen.queryByText('Geographical Allocation')).not.toBeInTheDocument();
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
        expect(screen.getByText('Geographical Allocation')).toBeInTheDocument();
      });
      // Stored decimals are shown as percentages.
      expect(screen.getByDisplayValue('60.00')).toBeInTheDocument();
      expect(screen.getByDisplayValue('25.00')).toBeInTheDocument();
    });

    it('does not surface a provider "Other" slice as a country row', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        countryWeightings: [
          { name: 'United States', weight: 0.6 },
          { name: 'Other', weight: 0.1 },
        ],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Geographical Allocation')).toBeInTheDocument();
      });
      // The real country shows as an editable row...
      expect(screen.getByDisplayValue('60.00')).toBeInTheDocument();
      // ...but the provider "Other" (10) is not rendered as its own row.
      expect(screen.queryByDisplayValue('10.00')).not.toBeInTheDocument();
    });

    it('submits the country allocation back as decimals (0-1)', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        countryWeightings: [{ name: 'United States', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Geographical Allocation')).toBeInTheDocument();
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

    it('offers custom countries fetched from the backend in the picker', async () => {
      (investmentsApi.getCountryOptions as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['Canada', 'Iceland', 'United States']);
      const etf = createSecurity({
        securityType: 'ETF',
        countryWeightings: [{ name: 'United States', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Geographical Allocation')).toBeInTheDocument();
      });
      expect(investmentsApi.getCountryOptions).toHaveBeenCalled();

      // Opening the row's combobox surfaces the user's custom country.
      const countryInput = screen.getByDisplayValue('United States');
      await act(async () => {
        fireEvent.focus(countryInput);
      });
      expect(screen.getByText('Iceland')).toBeInTheDocument();
    });

    it('submits a custom country typed straight into a new row', async () => {
      const etf = createSecurity({ securityType: 'ETF', countryWeightings: [] });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Geographical Allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Add country'));
      });

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Country'), {
          target: { value: 'Narnia' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Percentage'), {
          target: { value: '50' },
        });
      });

      // Mousedown commits the typed custom value; the click then submits the form.
      const submit = screen.getByText('Update Security');
      await act(async () => {
        fireEvent.mouseDown(submit);
      });
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            countryWeightings: [{ name: 'Narnia', weight: 0.5 }],
          }),
        );
      });
    });
  });

  describe('asset allocation', () => {
    it('hides the asset allocation editor for non-fund securities', async () => {
      const stock = createSecurity({ securityType: 'STOCK' });
      render(<SecurityForm security={stock} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByDisplayValue('AAPL')).toBeInTheDocument();
      });
      expect(screen.queryByText('Asset Allocation')).not.toBeInTheDocument();
    });

    it('shows and prefills the asset allocation editor for an ETF', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        assetWeightings: [
          { name: 'Equity', weight: 0.6 },
          { name: 'Fixed Income', weight: 0.3 },
        ],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });
      // Stored decimals are shown as percentages.
      expect(screen.getByDisplayValue('60.00')).toBeInTheDocument();
      expect(screen.getByDisplayValue('30.00')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Equity')).toBeInTheDocument();
    });

    it('submits the asset allocation back as decimals (0-1)', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        assetWeightings: [{ name: 'Equity', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Update Security'));
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            assetWeightings: [{ name: 'Equity', weight: 0.6 }],
          }),
        );
      });
    });

    it('offers the asset classes the user has already saved', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        assetWeightings: [{ name: 'Equity', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });
      expect(investmentsApi.getAssetOptions).toHaveBeenCalled();

      await act(async () => {
        fireEvent.focus(screen.getByLabelText('Asset class'));
      });
      expect(screen.getByText('Cash')).toBeInTheDocument();
    });

    it('submits a free-text asset class typed straight into a new row', async () => {
      const etf = createSecurity({ securityType: 'ETF', assetWeightings: [] });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Add asset class'));
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Asset class'), {
          target: { value: 'Preferred Shares' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Percentage'), {
          target: { value: '40' },
        });
      });

      // Mousedown commits the typed custom value; the click then submits.
      const submit = screen.getByText('Update Security');
      await act(async () => {
        fireEvent.mouseDown(submit);
      });
      await act(async () => {
        fireEvent.click(submit);
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            assetWeightings: [{ name: 'Preferred Shares', weight: 0.4 }],
          }),
        );
      });
    });

    it('deletes an asset class from the list after confirmation', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        assetWeightings: [
          { name: 'Equity', weight: 0.6 },
          { name: 'Cash', weight: 0.1 },
        ],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.focus(screen.getAllByLabelText('Asset class')[0]);
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Delete asset class: Equity'));
      });

      // Destructive: nothing happens until the user confirms.
      expect(screen.getByText('Delete asset class?')).toBeInTheDocument();
      expect(investmentsApi.deleteAssetOption).not.toHaveBeenCalled();

      const confirmDialog = screen.getByRole('dialog');
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));
      });

      await waitFor(() => {
        expect(investmentsApi.deleteAssetOption).toHaveBeenCalledWith('Equity');
      });
      // Its row is gone -- the freed 60% becomes the computed "Other" remainder.
      await waitFor(() => {
        expect(screen.queryByDisplayValue('60.00')).not.toBeInTheDocument();
      });
      expect(screen.getByDisplayValue('10.00')).toBeInTheDocument();
      const remainders = screen.getAllByTestId('allocation-other');
      expect(remainders[remainders.length - 1]).toHaveTextContent('90.00%');
    });

    it('keeps the class when the delete is cancelled', async () => {
      const etf = createSecurity({
        securityType: 'ETF',
        assetWeightings: [{ name: 'Equity', weight: 0.6 }],
      });
      render(<SecurityForm security={etf} onSubmit={onSubmit} onCancel={onCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.focus(screen.getByLabelText('Asset class'));
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Delete asset class: Equity'));
      });
      const confirmDialog = screen.getByRole('dialog');
      await act(async () => {
        fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));
      });

      expect(investmentsApi.deleteAssetOption).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('60.00')).toBeInTheDocument();
    });
  });
  describe('bond program', () => {
    const programs = [
      { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 12, newestSeriesCode: 'EDO1036', infoUrl: 'https://example.test/edo' },
      { id: 'p-tos', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'TOS', currency: 'PLN', seriesCount: 3, newestSeriesCode: 'TOS1029' },
      { id: 'p-usd', issuerCountryCode: 'US', issuerCode: 'US_TR', programCode: 'TBOND', currency: 'USD', seriesCount: 1, newestSeriesCode: null },
    ];
    const EDO_NAME = 'EDO: 10-year inflation-indexed savings bonds';
    const LABEL = 'Bond kind';

    beforeEach(() => {
      vi.mocked(investmentsApi.listBondPrograms).mockResolvedValue(programs);
    });

    const renderBond = async (overrides: Partial<Security> = {}) => {
      await act(async () => {
        render(
          <SecurityForm
            security={createSecurity({ securityType: 'BOND', currencyCode: 'PLN', ...overrides })}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />,
        );
      });
    };
    const programSelect = async () => (await screen.findByLabelText(LABEL)) as HTMLSelectElement;
    // An unlinked bond starts on the country "Other"; a program is reached by choosing a country.
    const pickPoland = async () => {
      const country = (await screen.findByLabelText('Country')) as HTMLSelectElement;
      await waitFor(() => expect(within(country).getByRole('option', { name: 'Poland' })).toBeInTheDocument());
      fireEvent.change(country, { target: { value: 'PL' } });
    };

    it('shows the program select only for a BOND and does not fetch the catalog otherwise', async () => {
      await act(async () => {
        render(<SecurityForm security={createSecurity({ securityType: 'STOCK' })} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.queryByLabelText(LABEL)).not.toBeInTheDocument();
      expect(investmentsApi.listBondPrograms).not.toHaveBeenCalled();

      await renderBond({ bondProgramId: 'p-edo' });
      expect(await screen.findByLabelText(LABEL)).toBeInTheDocument();
    });

    it('no longer offers a series picker or a search by series code', async () => {
      await renderBond({ bondProgramId: 'p-edo' });
      await programSelect();
      expect(screen.queryByLabelText('Bond series (optional)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Find a series by code')).not.toBeInTheDocument();
    });

    it('offers the programs of the chosen country by their translated name, plus Not linked', async () => {
      await renderBond();
      await pickPoland();
      const select = await programSelect();
      await waitFor(() =>
        expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
          'Not linked',
          EDO_NAME,
          'TOS: 3-year fixed-rate savings bonds',
        ]),
      );
      fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'US' } });
      const usSelect = await programSelect();
      await waitFor(() =>
        expect(within(usSelect).getAllByRole('option').map((o) => o.textContent)).toEqual([
          'Not linked',
          'TBOND',
        ]),
      );
    });

    it('fills the symbol, the name and the currency from the program chosen, and sends its link', async () => {
      await act(async () => {
        render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
      });
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('EDO'));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(EDO_NAME);
      expect((screen.getByLabelText('Website') as HTMLInputElement).value).toBe('https://example.test/edo');
      // The currency comes from the program and is not offered.
      expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            symbol: 'EDO',
            name: EDO_NAME,
            securityType: 'BOND',
            currencyCode: 'PLN',
            bondProgramId: 'p-edo',
            quoteProvider: null,
          }),
        ),
      );
      // The switch is off by default, so nothing is sent for it.
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondAutoFetch');
    });

    it('clears a web-page provider the listed bond no longer shows', async () => {
      // Chosen before the type became a listed bond: the provider and its page
      // field are hidden now, so the save must neither need nor keep them.
      await renderBond({ quoteProvider: 'html_table' });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      expect(screen.queryByTestId('quote-table-url-field')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ bondProgramId: 'p-edo', quoteProvider: null }),
        ),
      );
    });

    it('refills every field of an existing security when the person picks another kind', async () => {
      await renderBond({ symbol: 'MYBOND', name: 'My bonds', currencyCode: 'USD', exchange: 'NYSE', website: 'https://old.test' });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('EDO'));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(EDO_NAME);
      expect((screen.getByLabelText('Website') as HTMLInputElement).value).toBe('https://example.test/edo');
      fireEvent.change(select, { target: { value: 'p-tos' } });
      await waitFor(() => expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('TOS'));
      // TOS has no infoUrl: the website is left as it was.
      expect((screen.getByLabelText('Website') as HTMLInputElement).value).toBe('https://example.test/edo');
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ symbol: 'TOS', currencyCode: 'PLN', bondProgramId: 'p-tos' }),
        ),
      );
      // The stored exchange is cleared explicitly: undefined would be stripped
      // and leave 'NYSE' on a listed bond.
      expect(onSubmit.mock.calls[0][0].exchange).toBeNull();
    });

    it('sends no exchange for a listed bond that never had one', async () => {
      await renderBond({ symbol: 'MYBOND', name: 'My bonds', currencyCode: 'USD', exchange: null });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('EDO'));
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].exchange).toBeUndefined();
    });

    it('does not overwrite the stored fields when an existing linked security is opened', async () => {
      await renderBond({ symbol: 'MYBOND', name: 'My bonds', bondProgramId: 'p-edo', website: 'https://old.test' });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('MYBOND');
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My bonds');
      expect((screen.getByLabelText('Website') as HTMLInputElement).value).toBe('https://old.test');
    });

    it('fills an empty symbol and name of an existing security from the program', async () => {
      await renderBond({ symbol: '', name: '' });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('EDO'));
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(EDO_NAME);
    });

    it('opens a new security on the program a caller preselected', async () => {
      await act(async () => {
        render(
          <SecurityForm
            defaults={{
              symbol: 'EDO',
              name: EDO_NAME,
              securityType: 'BOND',
              currencyCode: 'PLN',
              bondProgramId: 'p-edo',
            }}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />,
        );
      });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-edo' }),
        ),
      );
    });

    it('sends the chosen program id on submit of an existing security', async () => {
      await renderBond();
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-tos' } });
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bondProgramId: 'p-tos' })),
      );
    });

    it('sends bondProgramId null and bondAutoFetch false for a BOND of the country Other', async () => {
      await renderBond();
      await screen.findByLabelText('Country');
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ securityType: 'BOND', bondProgramId: null, bondAutoFetch: false }),
        ),
      );
    });

    it('omits bondProgramId when a linked BOND is saved with its link unchanged', async () => {
      await renderBond({ bondProgramId: 'p-edo' });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondProgramId');
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondAutoFetch');
    });

    it('refuses a listed country left without a bond kind, with the required error', async () => {
      await renderBond({ bondProgramId: 'p-edo', bondAutoFetch: true });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      fireEvent.change(select, { target: { value: '' } });
      fireEvent.click(screen.getByText('Update Security'));
      expect(await screen.findByText('Bond kind is required')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
      // The country stays: emptying the kind does not turn it into Other.
      expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe('PL');
    });

    it('requires a kind for a new Bond of a listed country, and clears the error once one is picked', async () => {
      await act(async () => {
        render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
      });
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.click(screen.getByText('Create Security'));
      expect(await screen.findByText('Bond kind is required')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect(screen.queryByText('Bond kind is required')).not.toBeInTheDocument());
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    });

    it('blocks a stored currency that disagrees with the linked program, and keeps Currency visible to repair it', async () => {
      await renderBond({ bondProgramId: 'p-edo', currencyCode: 'USD' });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      expect(screen.getByLabelText('Currency')).toBeInTheDocument();
      // The link is kept, never dropped.
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('linked to a bond kind in PLN'));
      expect(select.value).toBe('p-edo');
      const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '');
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('linked to a bond kind in PLN')));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('lets the currency change once the person moves the country to Other', async () => {
      await renderBond({ bondProgramId: 'p-edo' });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'OTHER' } });
      fireEvent.change(await screen.findByLabelText('Currency'), { target: { value: 'USD' } });
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ currencyCode: 'USD', bondProgramId: null }),
        ),
      );
    });

    it('takes the currency from the program picked in an edit, so no mismatch is reported', async () => {
      await renderBond({ currencyCode: 'USD' });
      await pickPoland();
      const select = await programSelect();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      await waitFor(() => expect(select.value).toBe('p-edo'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'PLN' })));
    });

    it('offers only Other when the catalog holds no program, and no program select', async () => {
      vi.mocked(investmentsApi.listBondPrograms).mockResolvedValue([]);
      await renderBond();
      const country = (await screen.findByLabelText('Country')) as HTMLSelectElement;
      expect(within(country).getAllByRole('option').map((o) => o.textContent)).toEqual(['Other']);
      expect(screen.queryByLabelText(LABEL)).not.toBeInTheDocument();
    });

    it('keeps the stored link when the catalog could not be loaded', async () => {
      vi.mocked(investmentsApi.listBondPrograms).mockRejectedValue(new Error('down'));
      await renderBond({ bondProgramId: 'p-edo' });
      await programSelect();
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondProgramId');
    });

    it('hides the quote provider controls for a linked program and submits the stored values unchanged', async () => {
      await renderBond({ bondProgramId: 'p-edo', quoteProvider: 'msn', msnInstrumentId: 'abc123' });
      const select = await programSelect();
      await waitFor(() => expect(select.value).toBe('p-edo'));
      expect(screen.queryByLabelText('Quote Provider')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('MSN Instrument ID (advanced)')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ quoteProvider: 'msn', msnInstrumentId: 'abc123' }),
        ),
      );
      expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondProgramId');
    });

    it('shows the quote provider select again after a linked BOND is moved to the country Other', async () => {
      await renderBond({ bondProgramId: 'p-edo' });
      await programSelect();
      await waitFor(() => expect(screen.queryByLabelText('Quote Provider')).not.toBeInTheDocument());
      fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'OTHER' } });
      expect(await screen.findByLabelText('Quote Provider')).toBeInTheDocument();
    });

    it('shows the quote provider controls and Currency for the country Other, and hides them for a listed country', async () => {
      await renderBond({ bondProgramId: null, quoteProvider: 'msn', msnInstrumentId: 'abc123' });
      await screen.findByLabelText('Country');
      expect(screen.getByLabelText('Quote Provider')).toBeInTheDocument();
      expect(screen.getByLabelText('MSN Instrument ID (advanced)')).toBeInTheDocument();
      expect(screen.getByLabelText('Currency')).toBeInTheDocument();
      expect(screen.getByLabelText('Lookup provider')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Lookup' })).toBeInTheDocument();
      expect(screen.getByText('Disable automatic price updates')).toBeInTheDocument();
      await pickPoland();
      await waitFor(() => expect(screen.queryByLabelText('Quote Provider')).not.toBeInTheDocument());
      expect(screen.queryByLabelText('MSN Instrument ID (advanced)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Lookup provider')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Lookup' })).not.toBeInTheDocument();
      expect(screen.queryByText('Disable automatic price updates')).not.toBeInTheDocument();
    });

    it('says the catalog is loading while the request is pending', async () => {
      let resolveList!: (list: typeof programs) => void;
      vi.mocked(investmentsApi.listBondPrograms).mockReturnValue(
        new Promise((resolve) => (resolveList = resolve)),
      );
      await renderBond({ bondProgramId: 'p-edo' });
      expect(screen.getByText('Loading the bond kinds...')).toBeInTheDocument();
      await act(async () => {
        resolveList(programs);
      });
      expect(screen.queryByText('Loading the bond kinds...')).not.toBeInTheDocument();
    });

    it('says a failed catalog request failed, not that the catalog is empty, and retries', async () => {
      vi.mocked(investmentsApi.listBondPrograms).mockRejectedValueOnce(new Error('down'));
      await renderBond({ bondProgramId: 'p-edo' });
      const select = await programSelect();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The bond kinds could not be loaded');
      expect(screen.queryByText('Loading the bond kinds...')).not.toBeInTheDocument();
      expect(screen.queryByText('The bond catalog holds no bond kind yet.')).not.toBeInTheDocument();
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not linked', 'Linked bond kind']);

      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      });
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
      expect(investmentsApi.listBondPrograms).toHaveBeenCalledTimes(2);
    });

    it('unlinks a linked security whose type is moved away from BOND', async () => {
      await renderBond({ bondProgramId: 'p-edo' });
      await programSelect();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'STOCK' } });
      fireEvent.click(screen.getByText('Update Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bondProgramId: null })),
      );
    });

    describe('the auto-fetch switch', () => {
      const SWITCH = 'Fetch new series of this bond kind automatically';

      it('appears only once a program is linked, and is off by default', async () => {
        await renderBond();
        await pickPoland();
        const select = await programSelect();
        await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
        expect(screen.queryByRole('switch', { name: SWITCH })).not.toBeInTheDocument();
        fireEvent.change(select, { target: { value: 'p-edo' } });
        expect(await screen.findByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'false');
      });

      it('sends bondAutoFetch when it is switched on', async () => {
        await renderBond({ bondProgramId: 'p-edo' });
        await programSelect();
        fireEvent.click(await screen.findByRole('switch', { name: SWITCH }));
        expect(screen.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByText('Update Security'));
        await waitFor(() =>
          expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bondAutoFetch: true })),
        );
      });

      it('starts on for a security that has it on, and omits it when unchanged', async () => {
        await renderBond({ bondProgramId: 'p-edo', bondAutoFetch: true });
        await programSelect();
        expect(await screen.findByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'true');
        fireEvent.click(screen.getByText('Update Security'));
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('bondAutoFetch');
      });
    });
  });

  describe('bond country and field order', () => {
    const programs = [
      { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 12, newestSeriesCode: 'EDO1036' },
      { id: 'p-tos', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'TOS', currency: 'PLN', seriesCount: 3, newestSeriesCode: 'TOS1029' },
    ];

    beforeEach(() => {
      vi.mocked(investmentsApi.listBondPrograms).mockResolvedValue(programs);
    });

    const renderNew = async (props: Partial<React.ComponentProps<typeof SecurityForm>> = {}) => {
      await act(async () => {
        render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} {...props} />);
      });
    };
    const before = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('puts Type, Exchange and Currency before Symbol and Name', async () => {
      await renderNew();
      const symbol = screen.getByLabelText('Symbol');
      const name = screen.getByLabelText('Name');
      const type = screen.getByLabelText('Type');
      const exchange = screen.getByText('Exchange');
      const currency = screen.getByLabelText('Currency');
      expect(before(type, exchange)).toBe(true);
      expect(before(exchange, currency)).toBe(true);
      expect(before(currency, symbol)).toBe(true);
      expect(before(symbol, name)).toBe(true);
    });

    it('puts Country right after Type for a Bond, and the required Bond kind directly below', async () => {
      await renderNew();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      const country = await screen.findByLabelText('Country');
      const type = screen.getByLabelText('Type');
      expect(type.parentElement?.parentElement).toBe(country.parentElement?.parentElement);
      expect(type.parentElement?.nextElementSibling).toBe(country.parentElement);
      fireEvent.change(country, { target: { value: 'PL' } });
      const kind = await screen.findByLabelText('Bond kind');
      expect(before(country, kind)).toBe(true);
      expect(before(kind, screen.getByLabelText('Symbol'))).toBe(true);
    });

    it('does not require a bond kind for the country Other', async () => {
      await renderNew({ defaults: { symbol: 'MYB', name: 'My bond', securityType: 'BOND', currencyCode: 'USD' } });
      await screen.findByLabelText('Country');
      expect(screen.queryByText('Bond kind is required')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    });

    it('shows Country only for a Bond', async () => {
      await renderNew();
      expect(screen.queryByLabelText('Country')).not.toBeInTheDocument();
      expect(screen.getByText('Exchange')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      expect(await screen.findByLabelText('Country')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'ETF' } });
      expect(screen.queryByLabelText('Country')).not.toBeInTheDocument();
    });

    it('defaults to Other: the GitHub request link, the Exchange field, and no program select or switch', async () => {
      await renderNew();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      const country = (await screen.findByLabelText('Country')) as HTMLSelectElement;
      await waitFor(() =>
        expect(within(country).getAllByRole('option').map((o) => o.textContent)).toEqual(['Poland', 'Other']),
      );
      expect(country.value).toBe('OTHER');
      const link = screen.getByRole('link', { name: 'GitHub' });
      expect(link).toHaveAttribute('href', 'https://github.com/kenlasko/monize/discussions');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText('Exchange')).toBeInTheDocument();
      expect(screen.queryByLabelText('Bond kind')).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: 'Fetch new series of this bond kind automatically' })).not.toBeInTheDocument();
    });

    it('shows the program select for Poland, hides Exchange and the GitHub hint, and sends no exchange', async () => {
      await renderNew();
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'BOND' } });
      const country = await screen.findByLabelText('Country');
      await waitFor(() => expect(within(country).getByRole('option', { name: 'Poland' })).toBeInTheDocument());
      fireEvent.change(country, { target: { value: 'PL' } });
      const select = (await screen.findByLabelText('Bond kind')) as HTMLSelectElement;
      expect(screen.queryByText('Exchange')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument();
      await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
      fireEvent.change(select, { target: { value: 'p-edo' } });
      expect(await screen.findByRole('switch', { name: 'Fetch new series of this bond kind automatically' })).toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].exchange).toBeUndefined();
      expect(onSubmit.mock.calls[0][0]).toEqual(expect.objectContaining({ bondProgramId: 'p-edo' }));
    });

    it('sends bondProgramId null and bondAutoFetch false when a new Bond stays on Other', async () => {
      await renderNew({ defaults: { symbol: 'MYB', name: 'My bond', securityType: 'BOND', currencyCode: 'USD' } });
      await screen.findByLabelText('Country');
      fireEvent.click(screen.getByText('Create Security'));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ securityType: 'BOND', bondProgramId: null, bondAutoFetch: false }),
        ),
      );
    });

    it('opens a security linked to a program on its country', async () => {
      await act(async () => {
        render(
          <SecurityForm
            security={createSecurity({ securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-edo', exchange: null })}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />,
        );
      });
      const country = (await screen.findByLabelText('Country')) as HTMLSelectElement;
      await waitFor(() => expect(country.value).toBe('PL'));
      expect((screen.getByLabelText('Bond kind') as HTMLSelectElement).value).toBe('p-edo');
      expect(screen.queryByText('Exchange')).not.toBeInTheDocument();
    });

    it('resets the program when the country changes', async () => {
      await act(async () => {
        render(
          <SecurityForm
            security={createSecurity({ securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-edo', bondAutoFetch: true })}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />,
        );
      });
      const country = (await screen.findByLabelText('Country')) as HTMLSelectElement;
      await waitFor(() => expect(country.value).toBe('PL'));
      fireEvent.change(country, { target: { value: 'OTHER' } });
      expect(screen.queryByLabelText('Bond kind')).not.toBeInTheDocument();
      fireEvent.change(country, { target: { value: 'PL' } });
      expect((await screen.findByLabelText('Bond kind') as HTMLSelectElement).value).toBe('');
      expect(screen.queryByRole('switch', { name: 'Fetch new series of this bond kind automatically' })).not.toBeInTheDocument();
    });
  });
});

describe('SecurityForm page address on save', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves quoteUrl out of a save that did not touch it, so an older server accepts it', async () => {
    render(
      <SecurityForm
        security={createSecurity({ quoteProvider: 'html_table', quoteUrl: 'https://example.com/prices' })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => {});
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('quoteUrl');
  });

  it('leaves quoteUrl out of a save for a security that never had one', async () => {
    render(<SecurityForm security={createSecurity()} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Update Security'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('quoteUrl');
  });
});
