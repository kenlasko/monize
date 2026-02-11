import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CurrencyList } from './CurrencyList';

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    deleteCurrency: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

describe('CurrencyList', () => {
  const onEdit = vi.fn();
  const onToggleActive = vi.fn();
  const onRefresh = vi.fn();
  const getRate = vi.fn().mockReturnValue(null);

  const defaultProps = {
    usage: {} as Record<string, { accounts: number; securities: number }>,
    defaultCurrency: 'CAD',
    getRate,
    onEdit,
    onToggleActive,
    onRefresh,
  };

  it('renders empty state', () => {
    render(<CurrencyList currencies={[]} {...defaultProps} />);
    expect(screen.getByText('No currencies')).toBeInTheDocument();
  });

  it('renders currencies table with data', () => {
    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: false, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('CAD')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAD' }));
  });

  it('shows deactivate button for active currencies', () => {
    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('shows activate button for inactive currencies', () => {
    const currencies = [
      { code: 'JPY', name: 'Japanese Yen', symbol: '\u00a5', decimalPlaces: 0, isActive: false, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Activate')).toBeInTheDocument();
  });

  it('shows Default badge for default currency', () => {
    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('toggles density when density button is clicked', () => {
    const currencies = [
      { code: 'CAD', name: 'Canadian Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    const densityButton = screen.getByText('Normal');
    fireEvent.click(densityButton);
    expect(screen.getByText('Compact')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Dense')).toBeInTheDocument();
  });

  it('displays exchange rate when available', () => {
    const rateGetter = vi.fn().mockReturnValue(0.7321);
    const currencies = [
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];

    render(<CurrencyList currencies={currencies} {...defaultProps} getRate={rateGetter} />);
    expect(screen.getByText('0.7321')).toBeInTheDocument();
  });

  it('displays usage information when currency is in use', () => {
    const currencies = [
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true, createdAt: '2025-01-01T00:00:00Z' },
    ] as any[];
    const usage = { USD: { accounts: 2, securities: 3 } };

    render(<CurrencyList currencies={currencies} {...defaultProps} usage={usage} />);
    expect(screen.getByText('2 accts, 3 secs')).toBeInTheDocument();
  });
});
