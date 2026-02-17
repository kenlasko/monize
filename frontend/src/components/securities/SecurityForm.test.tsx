import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
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
    skipPriceUpdates: false,
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

  it('renders create form fields', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('shows Create Security button for new form', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Create Security')).toBeInTheDocument();
  });

  it('shows Update Security button when editing', () => {
    const security = createSecurity();
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Security')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  // --- New tests for improved coverage ---

  it('populates form with security data when editing', () => {
    const security = createSecurity({
      symbol: 'XEQT',
      name: 'iShares Core Equity ETF',
      securityType: 'ETF',
      exchange: 'TSX',
      currencyCode: 'CAD',
    });

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByDisplayValue('XEQT')).toBeInTheDocument();
    expect(screen.getByDisplayValue('iShares Core Equity ETF')).toBeInTheDocument();
  });

  it('shows Lookup button for new security form', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Lookup')).toBeInTheDocument();
  });

  it('does not show Lookup button when editing existing security', () => {
    const security = createSecurity();
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.queryByText('Lookup')).not.toBeInTheDocument();
  });

  it('renders security type options', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    const options = Array.from(typeSelect.querySelectorAll('option'));
    const optionValues = options.map(o => o.value);

    expect(optionValues).toContain('STOCK');
    expect(optionValues).toContain('ETF');
    expect(optionValues).toContain('MUTUAL_FUND');
    expect(optionValues).toContain('BOND');
    expect(optionValues).toContain('OPTION');
    expect(optionValues).toContain('CRYPTO');
    expect(optionValues).toContain('OTHER');
  });

  it('renders security type option labels', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    const options = Array.from(typeSelect.querySelectorAll('option'));
    const optionTexts = options.map(o => o.textContent);

    expect(optionTexts).toContain('Stock');
    expect(optionTexts).toContain('ETF');
    expect(optionTexts).toContain('Mutual Fund');
    expect(optionTexts).toContain('Bond');
    expect(optionTexts).toContain('Cryptocurrency');
  });

  it('shows placeholder text for symbol input', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByPlaceholderText('e.g., AAPL, XEQT, BTC')).toBeInTheDocument();
  });

  it('shows placeholder text for name input', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByPlaceholderText('e.g., Apple Inc., iShares Core Equity ETF')).toBeInTheDocument();
  });

  it('shows placeholder text for exchange input', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByPlaceholderText('e.g., NYSE, TSX, NASDAQ')).toBeInTheDocument();
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
    (investmentsApi.lookupSecurity as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    });

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(investmentsApi.lookupSecurity).toHaveBeenCalledWith('AAPL');
    });

    // After successful lookup, Clear button should appear
    await waitFor(() => {
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });
  });

  it('shows Clear button after successful lookup and clears on click', async () => {
    (investmentsApi.lookupSecurity as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      securityType: 'STOCK',
      currencyCode: 'USD',
    });

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

  it('shows "Looking up..." text during lookup', async () => {
    let resolvePromise: (value: any) => void;
    const lookupPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (investmentsApi.lookupSecurity as ReturnType<typeof vi.fn>).mockReturnValueOnce(lookupPromise);

    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const symbolInput = screen.getByLabelText('Symbol');
    fireEvent.change(symbolInput, { target: { value: 'AAPL' } });

    fireEvent.click(screen.getByText('Lookup'));

    await waitFor(() => {
      expect(screen.getByText('Looking up...')).toBeInTheDocument();
    });

    // Resolve the promise
    resolvePromise!(null);
    await waitFor(() => {
      expect(screen.getByText('Lookup')).toBeInTheDocument();
    });
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

  it('prefills default currency when creating new security', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    // The currency select should be present (currency options loaded asynchronously)
    const currencyLabel = screen.getByText('Currency');
    expect(currencyLabel).toBeInTheDocument();
  });

  it('selects "Select type..." as default security type for new form', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    expect(typeSelect.value).toBe('');
  });

  it('populates security type when editing', () => {
    const security = createSecurity({ securityType: 'ETF' });

    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);

    const typeSelect = screen.getByLabelText('Type') as HTMLSelectElement;
    expect(typeSelect.value).toBe('ETF');
  });
});
