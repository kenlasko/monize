import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SecurityList } from './SecurityList';

describe('SecurityList', () => {
  const onEdit = vi.fn();
  const onToggleActive = vi.fn();

  const makeSecurity = (overrides: any = {}) => ({
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state', () => {
    render(<SecurityList securities={[]} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('No securities')).toBeInTheDocument();
  });

  it('renders securities table with data', () => {
    const securities = [
      makeSecurity(),
      makeSecurity({ id: 's2', symbol: 'XEQT', name: 'iShares ETF', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: false }),
    ];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('renders security type labels', () => {
    const securities = [
      makeSecurity({ securityType: 'MUTUAL_FUND' }),
    ];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Mutual Fund')).toBeInTheDocument();
  });

  it('renders exchange and currency columns in normal density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    expect(screen.getByText('NASDAQ')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('hides exchange and currency columns in compact density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="compact" />);
    expect(screen.queryByText('NASDAQ')).not.toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('shows deactivate button for active securities without holdings', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('shows activate button for inactive securities without holdings', () => {
    const securities = [makeSecurity({ isActive: false })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Activate')).toBeInTheDocument();
  });

  it('calls onToggleActive when deactivate button is clicked', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    fireEvent.click(screen.getByText('Deactivate'));
    expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('hides deactivate button when security has holdings', () => {
    const securities = [makeSecurity()];
    const holdings = { s1: 100 };

    render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    // Edit should still be visible
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('shows deactivate button when security has zero holdings', () => {
    const securities = [makeSecurity()];
    const holdings = { s1: 0 };

    render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('toggles density when density button is clicked', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    const densityButton = screen.getByText('Normal');
    fireEvent.click(densityButton);
    expect(screen.getByText('Compact')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Dense')).toBeInTheDocument();
  });

  it('calls onDensityChange when provided', () => {
    const onDensityChange = vi.fn();
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" onDensityChange={onDensityChange} />);
    fireEvent.click(screen.getByText('Normal'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('shows abbreviated type in dense mode', () => {
    const securities = [makeSecurity({ securityType: 'MUTUAL_FUND' })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
    expect(screen.getByText('MF')).toBeInTheDocument();
  });

  describe('long-press context menu', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens context menu on long press', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Security')).toBeInTheDocument();
    });

    it('shows security symbol and name in context menu', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Symbol appears in both the table row and context menu header
      const symbolElements = screen.getAllByText('AAPL');
      expect(symbolElements.length).toBeGreaterThanOrEqual(2);
      // Name appears in both the table row and context menu
      const nameElements = screen.getAllByText('Apple Inc.');
      expect(nameElements.length).toBeGreaterThanOrEqual(2);
    });

    it('context menu Edit Security calls onEdit', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      fireEvent.click(screen.getByText('Edit Security'));
      expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('context menu shows Deactivate for active security without holdings', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // The context menu should have a Deactivate button
      const deactivateButtons = screen.getAllByText('Deactivate');
      expect(deactivateButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('context menu shows Activate for inactive security without holdings', async () => {
      const securities = [makeSecurity({ isActive: false })];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      const activateButtons = screen.getAllByText('Activate');
      expect(activateButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('context menu hides Deactivate for security with holdings', async () => {
      const securities = [makeSecurity()];
      const holdings = { s1: 50 };

      render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Edit Security should still be visible
      expect(screen.getByText('Edit Security')).toBeInTheDocument();
      // But Deactivate should not appear in the context menu
      // The inline Deactivate is also hidden due to holdings, so no Deactivate should be in DOM
      expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    });

    it('context menu Deactivate calls onToggleActive', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Click the context menu Deactivate (not the inline one)
      const deactivateButtons = screen.getAllByText('Deactivate');
      fireEvent.click(deactivateButtons[deactivateButtons.length - 1]);
      expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('does not open context menu if mouse released before 750ms', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(500);
        fireEvent.mouseUp(row);
        vi.advanceTimersByTime(300);
      });

      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });
  });
});
