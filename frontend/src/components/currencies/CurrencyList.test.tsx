import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
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

  const makeCurrency = (overrides: any = {}) => ({
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    decimalPlaces: 2,
    isActive: true,
    isSystem: false,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state', () => {
    render(<CurrencyList currencies={[]} {...defaultProps} />);
    expect(screen.getByText('No currencies')).toBeInTheDocument();
  });

  it('renders currencies table with data', () => {
    const currencies = [
      makeCurrency({ code: 'CAD', name: 'Canadian Dollar' }),
      makeCurrency({ code: 'USD', name: 'US Dollar', isActive: false }),
    ];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('CAD')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAD' }));
  });

  it('shows deactivate button for non-default, unused active currency', () => {
    const currencies = [makeCurrency()];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('shows activate button for inactive currencies', () => {
    const currencies = [makeCurrency({ code: 'JPY', name: 'Japanese Yen', symbol: '\u00a5', isActive: false })];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Activate')).toBeInTheDocument();
  });

  it('hides deactivate button for default currency', () => {
    const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    // Edit should still be visible
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('hides deactivate button for currency in use', () => {
    const currencies = [makeCurrency()];
    const usage = { USD: { accounts: 2, securities: 0 } };

    render(<CurrencyList currencies={currencies} {...defaultProps} usage={usage} />);
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  describe('isSystem flag', () => {
    it('hides Edit button for system currencies in row actions', () => {
      const currencies = [makeCurrency({ code: 'USD', isSystem: true })];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('shows Edit button for non-system currencies', () => {
      const currencies = [makeCurrency({ code: 'USD', isSystem: false })];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('shows Edit for non-system but hides for system in mixed list', () => {
      const currencies = [
        makeCurrency({ code: 'CAD', name: 'Canadian Dollar', isSystem: true }),
        makeCurrency({ code: 'XYZ', name: 'Custom Currency', symbol: 'X', isSystem: false }),
      ];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const editButtons = screen.getAllByText('Edit');
      expect(editButtons).toHaveLength(1);
    });

    it('hides Edit Currency in context menu for system currencies', async () => {
      vi.useFakeTimers();
      const currencies = [makeCurrency({ code: 'USD', isSystem: true })];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.queryByText('Edit Currency')).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('shows Edit Currency in context menu for non-system currencies', async () => {
      vi.useFakeTimers();
      const currencies = [makeCurrency({ code: 'USD', isSystem: false })];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Currency')).toBeInTheDocument();
      vi.useRealTimers();
    });
  });

  it('shows Default badge for default currency', () => {
    const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('toggles density when density button is clicked', () => {
    const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

    render(<CurrencyList currencies={currencies} {...defaultProps} />);
    const densityButton = screen.getByText('Normal');
    fireEvent.click(densityButton);
    expect(screen.getByText('Compact')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Dense')).toBeInTheDocument();
  });

  it('displays exchange rate when available', () => {
    const rateGetter = vi.fn().mockReturnValue(0.7321);
    const currencies = [makeCurrency()];

    render(<CurrencyList currencies={currencies} {...defaultProps} getRate={rateGetter} />);
    expect(screen.getByText('0.7321')).toBeInTheDocument();
  });

  it('displays usage information when currency is in use', () => {
    const currencies = [makeCurrency()];
    const usage = { USD: { accounts: 2, securities: 3 } };

    render(<CurrencyList currencies={currencies} {...defaultProps} usage={usage} />);
    expect(screen.getByText('2 accts, 3 secs')).toBeInTheDocument();
  });

  it('calls onDensityChange when provided', () => {
    const onDensityChange = vi.fn();
    const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

    render(<CurrencyList currencies={currencies} {...defaultProps} density="normal" onDensityChange={onDensityChange} />);
    fireEvent.click(screen.getByText('Normal'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  describe('long-press context menu', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens context menu on long press', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Currency')).toBeInTheDocument();
    });

    it('shows currency code and name in context menu', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Code appears in both table row and context menu header
      const codeElements = screen.getAllByText('USD');
      expect(codeElements.length).toBeGreaterThanOrEqual(2);
      // Name appears in both table row and context menu
      const nameElements = screen.getAllByText('US Dollar');
      expect(nameElements.length).toBeGreaterThanOrEqual(2);
    });

    it('context menu Edit Currency calls onEdit', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      fireEvent.click(screen.getByText('Edit Currency'));
      expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ code: 'USD' }));
    });

    it('context menu shows Deactivate and Delete for non-default, unused currency', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      const deactivateButtons = screen.getAllByText('Deactivate');
      expect(deactivateButtons.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Delete Currency')).toBeInTheDocument();
    });

    it('context menu hides Deactivate and Delete for default currency', async () => {
      const currencies = [makeCurrency({ code: 'CAD', name: 'Canadian Dollar' })];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('CAD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Currency')).toBeInTheDocument();
      expect(screen.queryByText('Delete Currency')).not.toBeInTheDocument();
    });

    it('context menu hides Deactivate and Delete for in-use currency', async () => {
      const currencies = [makeCurrency()];
      const usage = { USD: { accounts: 1, securities: 0 } };

      render(<CurrencyList currencies={currencies} {...defaultProps} usage={usage} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Currency')).toBeInTheDocument();
      expect(screen.queryByText('Delete Currency')).not.toBeInTheDocument();
    });

    it('context menu Deactivate calls onToggleActive', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      const deactivateButtons = screen.getAllByText('Deactivate');
      fireEvent.click(deactivateButtons[deactivateButtons.length - 1]);
      expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ code: 'USD' }));
    });

    it('does not open context menu if mouse released before 750ms', async () => {
      const currencies = [makeCurrency()];

      render(<CurrencyList currencies={currencies} {...defaultProps} />);
      const row = screen.getByText('USD').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(500);
        fireEvent.mouseUp(row);
        vi.advanceTimersByTime(300);
      });

      expect(screen.queryByText('Edit Currency')).not.toBeInTheDocument();
    });
  });
});
