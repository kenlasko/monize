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

  describe('cryptocurrency note', () => {
    const typeCode = (value: string) =>
      fireEvent.change(screen.getByPlaceholderText(/USD, EUR, GBP/), { target: { value } });

    it('points a non-ISO code at the user guide', () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BTC');
      expect(screen.getByText(/BTC is not a standard currency code/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'See how in the user guide' })).toHaveAttribute(
        'href',
        'https://www.monize.net/docs/investments#cryptocurrency',
      );
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

    it('still lets the user create the currency', async () => {
      render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
      typeCode('BTC');
      fireEvent.change(screen.getByPlaceholderText(/Canadian Dollar, Malaysia/), { target: { value: 'Bitcoin' } });
      fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'B' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Currency'));
      });
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ code: 'BTC' }));
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
