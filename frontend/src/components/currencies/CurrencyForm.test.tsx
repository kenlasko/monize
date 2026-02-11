import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CurrencyForm } from './CurrencyForm';

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    lookupCurrency: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('CurrencyForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

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

  it('shows Update Currency button when editing', () => {
    const currency = {
      code: 'USD',
      name: 'US Dollar',
      symbol: '$',
      decimalPlaces: 2,
      isActive: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Currency')).toBeInTheDocument();
  });

  it('shows Lookup button in create mode', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Lookup')).toBeInTheDocument();
  });

  it('hides Lookup button when editing', () => {
    const currency = {
      code: 'EUR',
      name: 'Euro',
      symbol: '\u20ac',
      decimalPlaces: 2,
      isActive: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.queryByText('Lookup')).not.toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<CurrencyForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables currency code input when editing', () => {
    const currency = {
      code: 'CAD',
      name: 'Canadian Dollar',
      symbol: '$',
      decimalPlaces: 2,
      isActive: true,
      createdAt: '2025-01-01T00:00:00Z',
    } as any;
    render(<CurrencyForm currency={currency} onSubmit={onSubmit} onCancel={onCancel} />);
    const codeInput = screen.getByDisplayValue('CAD');
    expect(codeInput).toBeDisabled();
  });
});
