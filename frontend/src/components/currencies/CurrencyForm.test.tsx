import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CurrencyForm } from './CurrencyForm';
import toast from 'react-hot-toast';

vi.mock('@hookform/resolvers/zod', () => ({
  // Echo the current form values through so submit handlers receive the typed
  // fields (validation itself is exercised elsewhere).
  zodResolver: () => async (values: any) => ({ values, errors: {} }),
}));

const mockLookupCurrency = vi.fn().mockResolvedValue(null);
const mockGetRateCoverage = vi.fn();

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    lookupCurrency: (...args: any[]) => mockLookupCurrency(...args),
    // The edit dialog carries the rate-history section, which reads coverage on
    // mount and the rate table through `useExchangeRates`.
    getRateCoverage: (...args: any[]) => mockGetRateCoverage(...args),
    getStoredRates: vi.fn(),
    fillRateGaps: vi.fn(),
    getLatestRates: () => Promise.resolve([]),
  },
}));

const mockLookupSecurity = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    lookupSecurity: (...args: any[]) => mockLookupSecurity(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

describe('CurrencyForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLookupCurrency.mockResolvedValue(null);
    mockLookupSecurity.mockResolvedValue(null);
    mockGetRateCoverage.mockResolvedValue({
      from: 'USD',
      to: 'CAD',
      earliestDate: '2026-01-02',
      latestDate: '2026-09-16',
      observations: 180,
    });
  });

  it('renders create form fields', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Currency Code')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Decimal Places')).toBeInTheDocument();
  });

  it('shows Create Currency button for new form', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Create Currency')).toBeInTheDocument();
  });

  it('shows Update Currency button when editing', async () => {
    const currency = {
      code: 'USD',
      name: 'US Dollar',
      symbol: '$',
      decimalPlaces: 2,
      isActive: true,
      isSystem: false,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    // Awaited: the edit dialog's rate-history section loads coverage on mount.
    await act(async () => {
      render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Update Currency')).toBeInTheDocument();
  });

  it('shows Lookup button in create mode', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Lookup')).toBeInTheDocument();
  });

  it('hides Lookup button when editing', async () => {
    const currency = {
      code: 'EUR',
      name: 'Euro',
      symbol: '\u20ac',
      decimalPlaces: 2,
      isActive: true,
      isSystem: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    // Awaited: the edit dialog's rate-history section loads coverage on mount.
    await act(async () => {
      render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.queryByText('Lookup')).not.toBeInTheDocument();
  });

  it('shows the rate history section when editing a non-default currency', async () => {
    const currency = {
      code: 'EUR',
      name: 'Euro',
      symbol: '€',
      decimalPlaces: 2,
      isActive: true,
      isSystem: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    await act(async () => {
      render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Rate history')).toBeInTheDocument();
    expect(mockGetRateCoverage).toHaveBeenCalledWith('EUR');
  });

  it('hides the rate history section in create mode', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.queryByText('Rate history')).not.toBeInTheDocument();
    expect(mockGetRateCoverage).not.toHaveBeenCalled();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables currency code input when editing', async () => {
    const currency = {
      code: 'CAD',
      name: 'Canadian Dollar',
      symbol: '$',
      decimalPlaces: 2,
      isActive: true,
      isSystem: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    // Awaited: the edit dialog's rate-history section loads coverage on mount.
    await act(async () => {
      render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    const codeInput = screen.getByDisplayValue('CAD');
    expect(codeInput).toBeDisabled();
  });

  it('shows error toast when Lookup clicked with empty fields', async () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('at least 2 characters'));
  });

  it('uses name field when code is too short', async () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    const nameInput = screen.getByPlaceholderText(/Canadian Dollar, Malaysia/);
    fireEvent.change(nameInput, { target: { value: 'US' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    expect(mockLookupCurrency).toHaveBeenCalledWith('US');
  });

  it('shows not found toast when lookup returns null', async () => {
    mockLookupCurrency.mockResolvedValue(null);
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    const codeInput = screen.getByPlaceholderText(/USD, EUR, GBP/);
    fireEvent.change(codeInput, { target: { value: 'XYZ' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No currency found'));
    });
  });

  it('fills form fields and shows Clear button when lookup succeeds', async () => {
    mockLookupCurrency.mockResolvedValue({ code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimalPlaces: 2 });
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    const codeInput = screen.getByPlaceholderText(/USD, EUR, GBP/);
    fireEvent.change(codeInput, { target: { value: 'CAD' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('CAD'));
  });

  it('clears form fields when Clear is clicked', async () => {
    mockLookupCurrency.mockResolvedValue({ code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimalPlaces: 2 });
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    const codeInput = screen.getByPlaceholderText(/USD, EUR, GBP/);
    fireEvent.change(codeInput, { target: { value: 'CAD' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    await waitFor(() => expect(screen.getByText('Clear')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Clear'));
    });
    await waitFor(() => expect(screen.queryByText('Clear')).not.toBeInTheDocument());
  });

  it('shows error toast when lookup throws', async () => {
    mockLookupCurrency.mockRejectedValue(new Error('Network error'));
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    const codeInput = screen.getByPlaceholderText(/USD, EUR, GBP/);
    fireEvent.change(codeInput, { target: { value: 'CAD' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Lookup'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Lookup failed - please try again');
    });
  });

  describe('non-ISO code notice', () => {
    const typeCode = (value: string) =>
      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value } });

    it('says the code is not standard and links the cryptocurrencies guide', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BTC');
      expect(screen.getByText(/BTC is not a standard currency code/)).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Read about cryptocurrencies in the user guide' }),
      ).toHaveAttribute('href', 'https://www.monize.net/docs/currency-management#cryptocurrencies');
    });

    it('offers switching the kind to Cryptocurrency', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BTC');
      fireEvent.click(screen.getByRole('button', { name: 'Use Cryptocurrency' }));
      expect(screen.getByRole('button', { name: 'Cryptocurrency' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByText(/not a standard currency code/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Price Symbol (optional)')).toBeInTheDocument();
    });

    it('stays quiet for an ISO code', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('EUR');
      expect(screen.queryByText(/not a standard currency code/)).not.toBeInTheDocument();
    });

    it('waits for a complete code', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BT');
      expect(screen.queryByText(/not a standard currency code/)).not.toBeInTheDocument();
      typeCode('BTCX');
      expect(screen.queryByText(/not a standard currency code/)).not.toBeInTheDocument();
    });

    it('still lets the user create the code as a fiat currency', async () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BTC');
      fireEvent.change(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/), { target: { value: 'Bitcoin' } });
      fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'B' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'BTC', kind: 'FIAT', quoteSymbol: null }),
      );
    });
  });

  describe('kind', () => {
    const chooseCrypto = () => fireEvent.click(screen.getByRole('button', { name: 'Cryptocurrency' }));
    const quoteInput = () => screen.getByLabelText('Price Symbol (optional)');

    it('starts as a fiat currency with no price symbol field', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByRole('button', { name: 'Fiat Currency' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Cryptocurrency' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByLabelText('Price Symbol (optional)')).not.toBeInTheDocument();
    });

    it('as a cryptocurrency shows the price symbol, its empty hint and the precision note', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      chooseCrypto();
      expect(quoteInput()).toBeInTheDocument();
      expect(screen.getByText('Without a price symbol the currency has no exchange rate.')).toBeInTheDocument();
      expect(
        screen.getByText(
          /kept to up to eight decimal places, the precision they are stored at, so a fee smaller than 0\.00000001 cannot be entered/,
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See how to record wallet fees' })).toHaveAttribute(
        'href',
        'https://www.monize.net/docs/accounts#cryptocurrency-wallets',
      );
    });

    it('defaults a coin to eight decimal places and a fiat currency back to two', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText('Decimal Places')).toHaveValue('2');
      chooseCrypto();
      expect(screen.getByLabelText('Decimal Places')).toHaveValue('8');
      fireEvent.click(screen.getByRole('button', { name: 'Fiat Currency' }));
      expect(screen.getByLabelText('Decimal Places')).toHaveValue('2');
    });

    it('holds decimal places at the eight a money column carries: 9 is refused', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      chooseCrypto();
      const decimals = screen.getByLabelText('Decimal Places');
      fireEvent.change(decimals, { target: { value: '9' } });
      fireEvent.blur(decimals);
      expect(screen.getByLabelText('Decimal Places')).toHaveValue('8');
    });

    it('leaves decimal places the reader typed alone when the kind changes', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      const decimals = screen.getByLabelText('Decimal Places');
      fireEvent.change(decimals, { target: { value: '3' } });
      fireEvent.blur(decimals);
      chooseCrypto();
      expect(screen.getByLabelText('Decimal Places')).toHaveValue('3');
    });

    it('sends the kind and the uppercased price symbol', async () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value: 'btc' } });
      chooseCrypto();
      fireEvent.change(quoteInput(), { target: { value: 'btc-eur' } });
      fireEvent.change(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/), { target: { value: 'Bitcoin' } });
      fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'B' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith({
        code: 'BTC',
        name: 'Bitcoin',
        symbol: 'B',
        decimalPlaces: 8,
        kind: 'CRYPTO',
        quoteSymbol: 'BTC-EUR',
      });
    });

    it('sends an empty price symbol as null: an unpriced coin', async () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value: 'XYZ' } });
      chooseCrypto();
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CRYPTO', quoteSymbol: null }));
    });

    it('drops the price symbol when the kind goes back to fiat', async () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      chooseCrypto();
      fireEvent.change(quoteInput(), { target: { value: 'BTC-EUR' } });
      fireEvent.click(screen.getByRole('button', { name: 'Fiat Currency' }));
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'FIAT', quoteSymbol: null }));
    });

    const btc = {
      code: 'BTC',
      name: 'Bitcoin',
      symbol: 'B',
      decimalPlaces: 8,
      isActive: true,
      isSystem: false,
      createdAt: '2026-11-05T00:00:00Z',
      kind: 'CRYPTO' as const,
      quoteSymbol: 'BTC-CAD',
    };

    it('is locked on a currency in use, and says why', async () => {
      await act(async () => {
        render(<CurrencyForm currency={btc} inUse onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.getByRole('button', { name: 'Fiat Currency' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cryptocurrency' })).toBeDisabled();
      expect(screen.getByText('BTC is in use, so its kind cannot change.')).toBeInTheDocument();
    });

    it('stays editable on a currency nothing uses', async () => {
      await act(async () => {
        render(<CurrencyForm currency={btc} onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(screen.getByRole('button', { name: 'Fiat Currency' })).not.toBeDisabled();
      expect(screen.queryByText(/so its kind cannot change/)).not.toBeInTheDocument();
    });

    it('loads a saved coin with its price symbol and the fiat it is priced in', async () => {
      await act(async () => {
        render(<CurrencyForm currency={btc} inUse onSubmit={onSubmit} onCancel={onCancel} />);
      });
      expect(quoteInput()).toHaveValue('BTC-CAD');
      expect(screen.getByText('Priced in CAD')).toBeInTheDocument();
    });

    it('round-trips an unedited saved coin', async () => {
      await act(async () => {
        render(<CurrencyForm currency={btc} inUse onSubmit={onSubmit} onCancel={onCancel} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith({
        code: 'BTC',
        name: 'Bitcoin',
        symbol: 'B',
        decimalPlaces: 8,
        kind: 'CRYPTO',
        quoteSymbol: 'BTC-CAD',
      });
    });
  });

  describe('verifying the price symbol', () => {
    const setUp = (symbol: string) => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole('button', { name: 'Cryptocurrency' }));
      fireEvent.change(screen.getByLabelText('Price Symbol (optional)'), { target: { value: symbol } });
    };
    const verify = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
      });
    };
    const coin = {
      symbol: 'BTC-EUR',
      name: 'Bitcoin EUR',
      exchange: 'CRYPTO',
      securityType: 'CRYPTO',
      currencyCode: 'EUR',
    };

    it('asks the Yahoo security lookup and shows the fiat a coin is priced in', async () => {
      mockLookupSecurity.mockResolvedValue(coin);
      setUp('btc-eur');
      await verify();
      expect(mockLookupSecurity).toHaveBeenCalledWith('BTC-EUR', undefined, 'yahoo');
      expect(screen.getByText('Priced in EUR')).toBeInTheDocument();
    });

    it('prefills an empty name from the result and keeps a typed one', async () => {
      mockLookupSecurity.mockResolvedValue(coin);
      setUp('BTC-EUR');
      await verify();
      expect(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/)).toHaveValue('Bitcoin EUR');

      fireEvent.change(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/), { target: { value: 'Bitcoin' } });
      await verify();
      expect(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/)).toHaveValue('Bitcoin');
    });

    it('refuses a symbol that is not a coin', async () => {
      mockLookupSecurity.mockResolvedValue({ ...coin, symbol: 'AAPL-USD', securityType: 'STOCK' });
      setUp('AAPL-USD');
      await verify();
      expect(screen.getByText('AAPL-USD is not a cryptocurrency. Enter a coin\'s pair, such as BTC-EUR.')).toBeInTheDocument();
      expect(screen.queryByText(/Priced in/)).not.toBeInTheDocument();
    });

    it('says so when nothing is found', async () => {
      mockLookupSecurity.mockResolvedValue(null);
      setUp('ZZZ-EUR');
      await verify();
      expect(screen.getByText('No cryptocurrency found for ZZZ-EUR')).toBeInTheDocument();
    });

    it('refuses a symbol without a fiat leg without asking', async () => {
      setUp('BTC');
      await verify();
      expect(mockLookupSecurity).not.toHaveBeenCalled();
      expect(screen.getByText(/Enter a pair such as BTC-EUR/)).toBeInTheDocument();
    });

    it('asks for a symbol before verifying an empty field', async () => {
      setUp('');
      await verify();
      expect(mockLookupSecurity).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Enter a price symbol such as BTC-EUR to verify');
    });

    it('reports a failed lookup as a failure, not as a missing coin', async () => {
      mockLookupSecurity.mockRejectedValue(new Error('Network error'));
      setUp('BTC-EUR');
      await verify();
      expect(toast.error).toHaveBeenCalledWith('Failed to verify the price symbol');
      expect(screen.queryByText(/No cryptocurrency found/)).not.toBeInTheDocument();
    });

    it('retires the answer once the symbol is edited', async () => {
      mockLookupSecurity.mockResolvedValue(coin);
      setUp('BTC-EUR');
      await verify();
      expect(screen.getByText('Priced in EUR')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Price Symbol (optional)'), { target: { value: 'BTC-USD' } });
      expect(screen.queryByText('Priced in EUR')).not.toBeInTheDocument();
    });
  });

  describe('inactive-currency reactivation', () => {
    const inactiveError = { response: { data: { errorCode: 'CURRENCY_INACTIVE' } } };

    it('shows a reactivation note when create fails because the currency is inactive', async () => {
      const failingSubmit = vi.fn().mockRejectedValue(inactiveError);
      const onReactivate = vi.fn().mockResolvedValue(undefined);
      render(
        <CurrencyForm onSubmit={failingSubmit} onCancel={onCancel} onReactivate={onReactivate} />,
      );

      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value: 'OLD' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });

      await waitFor(() =>
        expect(screen.getByText('OLD is already in your list but inactive.')).toBeInTheDocument(),
      );
      expect(screen.getByText('Reactivate OLD')).toBeInTheDocument();
    });

    it('calls onReactivate with the code when the reactivate button is clicked', async () => {
      const failingSubmit = vi.fn().mockRejectedValue(inactiveError);
      const onReactivate = vi.fn().mockResolvedValue(undefined);
      render(
        <CurrencyForm onSubmit={failingSubmit} onCancel={onCancel} onReactivate={onReactivate} />,
      );

      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value: 'old' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      await waitFor(() => expect(screen.getByText('Reactivate OLD')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByText('Reactivate OLD'));
      });
      expect(onReactivate).toHaveBeenCalledWith('OLD');
    });

    it('does not show the reactivation note when onReactivate is not provided', async () => {
      const failingSubmit = vi.fn().mockRejectedValue(inactiveError);
      render(<CurrencyForm onSubmit={failingSubmit} onCancel={onCancel} />);

      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value: 'OLD' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      await act(async () => {}); // flush the rejected submit handler

      expect(failingSubmit).toHaveBeenCalled();
      expect(screen.queryByText(/already in your list but inactive/)).not.toBeInTheDocument();
    });

    it('clears the reactivation note when the code is edited', async () => {
      const failingSubmit = vi.fn().mockRejectedValue(inactiveError);
      const onReactivate = vi.fn().mockResolvedValue(undefined);
      render(
        <CurrencyForm onSubmit={failingSubmit} onCancel={onCancel} onReactivate={onReactivate} />,
      );

      const codeInput = screen.getByPlaceholderText(/USD, EUR, GBP/);
      fireEvent.change(codeInput, { target: { value: 'OLD' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      await waitFor(() => expect(screen.getByText('Reactivate OLD')).toBeInTheDocument());

      fireEvent.change(codeInput, { target: { value: 'OLDER' } });
      expect(screen.queryByText('Reactivate OLD')).not.toBeInTheDocument();
    });
  });
});
