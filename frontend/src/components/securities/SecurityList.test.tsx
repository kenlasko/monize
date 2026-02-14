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

  // --- New tests for improved coverage ---

  it('renders empty state with descriptive text', () => {
    render(<SecurityList securities={[]} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('No securities')).toBeInTheDocument();
    expect(screen.getByText('Get started by adding your first security.')).toBeInTheDocument();
  });

  it('shows dash for security without securityType', () => {
    const securities = [makeSecurity({ securityType: null })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows dash for security without exchange', () => {
    const securities = [makeSecurity({ exchange: null })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    // Exchange column shows "-" when null
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('renders all table headers in normal density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('hides exchange and currency headers in compact density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="compact" />);
    expect(screen.queryByText('Exchange')).not.toBeInTheDocument();
    expect(screen.queryByText('Currency')).not.toBeInTheDocument();
    // These should still be visible
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('hides exchange and currency headers in dense density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
    expect(screen.queryByText('Exchange')).not.toBeInTheDocument();
    expect(screen.queryByText('Currency')).not.toBeInTheDocument();
  });

  it('applies opacity to inactive securities', () => {
    const securities = [makeSecurity({ isActive: false })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    const row = screen.getByText('AAPL').closest('tr')!;
    expect(row.className).toContain('opacity-60');
  });

  it('does not apply opacity to active securities', () => {
    const securities = [makeSecurity({ isActive: true })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    const row = screen.getByText('AAPL').closest('tr')!;
    expect(row.className).not.toContain('opacity-60');
  });

  it('shows abbreviated status badge in dense mode for active security', () => {
    const securities = [makeSecurity({ isActive: true })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
    expect(screen.getByText('Act')).toBeInTheDocument();
  });

  it('shows abbreviated status badge in dense mode for inactive security', () => {
    const securities = [makeSecurity({ isActive: false })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
    expect(screen.getByText('Ina')).toBeInTheDocument();
  });

  it('renders multiple securities in correct order', () => {
    const securities = [
      makeSecurity({ id: 's1', symbol: 'AAPL', name: 'Apple Inc.' }),
      makeSecurity({ id: 's2', symbol: 'MSFT', name: 'Microsoft Corp.' }),
      makeSecurity({ id: 's3', symbol: 'GOOG', name: 'Alphabet Inc.' }),
    ];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    const rows = screen.getAllByRole('row');
    // rows[0] = header, rows[1..3] = data rows
    expect(rows[1]).toHaveTextContent('AAPL');
    expect(rows[2]).toHaveTextContent('MSFT');
    expect(rows[3]).toHaveTextContent('GOOG');
  });

  it('cycles density from dense back to normal', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);

    // Start at Normal
    fireEvent.click(screen.getByText('Normal'));
    expect(screen.getByText('Compact')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Dense')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dense'));
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('shows all type abbreviations in dense mode', () => {
    const securities = [
      makeSecurity({ id: 's1', securityType: 'STOCK' }),
      makeSecurity({ id: 's2', securityType: 'ETF' }),
      makeSecurity({ id: 's3', securityType: 'BOND' }),
      makeSecurity({ id: 's4', securityType: 'OPTION' }),
      makeSecurity({ id: 's5', securityType: 'CRYPTO' }),
      makeSecurity({ id: 's6', securityType: 'OTHER' }),
    ];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);

    expect(screen.getByText('Stk')).toBeInTheDocument();
    expect(screen.getByText('ETF')).toBeInTheDocument();
    expect(screen.getByText('Bnd')).toBeInTheDocument();
    expect(screen.getByText('Opt')).toBeInTheDocument();
    expect(screen.getByText('Cry')).toBeInTheDocument();
    expect(screen.getByText('Oth')).toBeInTheDocument();
  });

  it('calls onToggleActive when activate button clicked for inactive security', () => {
    const securities = [makeSecurity({ isActive: false })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    fireEvent.click(screen.getByText('Activate'));
    expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
  });

  describe('long-press with touch events', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('cancels long press when touch moves beyond threshold', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
        vi.advanceTimersByTime(200);
        // Move beyond the threshold (10px)
        fireEvent.touchMove(row, { touches: [{ clientX: 120, clientY: 100 }] });
        vi.advanceTimersByTime(600);
      });

      // Context menu should NOT appear because touch moved
      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });

    it('cancels long press on mouse leave', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(200);
        fireEvent.mouseLeave(row);
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });

    it('cancels long press on touch cancel', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
        vi.advanceTimersByTime(200);
        fireEvent.touchCancel(row);
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });
  });
});
