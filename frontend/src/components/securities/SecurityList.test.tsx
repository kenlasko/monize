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
    isFavourite: false,
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

  it('shows the current share count column at full precision', () => {
    const securities = [makeSecurity()];
    const holdings = { s1: 0.0003 };

    render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Shares')).toBeInTheDocument();
    // Residual quantity shown exactly, not rounded away.
    expect(screen.getByText('0.0003')).toBeInTheDocument();
  });

  it('shows 0 shares when a security has no holdings', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders a History action and calls onViewHistory when clicked', () => {
    const securities = [makeSecurity()];
    const onViewHistory = vi.fn();

    render(
      <SecurityList
        securities={securities}
        onEdit={onEdit}
        onToggleActive={onToggleActive}
        onViewHistory={onViewHistory}
      />,
    );
    fireEvent.click(screen.getByText('History'));
    expect(onViewHistory).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('omits the History action when onViewHistory is not provided', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.queryByText('History')).not.toBeInTheDocument();
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
    // Type column shows "-" when null; the Provider column also renders "-",
    // so multiple dashes may be present.
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash for security without exchange', () => {
    const securities = [makeSecurity({ exchange: null })];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    // Exchange column shows "-" when null (provider column may also be "-").
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });

  it('renders all table headers in normal density', () => {
    const securities = [makeSecurity()];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders MSN badge in the Provider column when security has an MSN override', () => {
    const securities = [makeSecurity({ quoteProvider: 'msn' })];
    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    expect(screen.getByText('MSN')).toBeInTheDocument();
  });

  it('renders Yahoo badge in the Provider column when security has a Yahoo override', () => {
    const securities = [makeSecurity({ quoteProvider: 'yahoo' })];
    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    expect(screen.getByText('Yahoo')).toBeInTheDocument();
  });

  it('shows the default provider (inherited) when security has no override', () => {
    const securities = [makeSecurity({ quoteProvider: null })];
    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
    // Default in tests is "yahoo" (preferences store mock returns undefined → '?? yahoo').
    const yahooBadge = screen.getByText('Yahoo');
    expect(yahooBadge).toBeInTheDocument();
    // Italic class indicates the value is inherited from the default rather than an override.
    expect(yahooBadge.className).toContain('italic');
    expect(yahooBadge.title).toMatch(/default/i);
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

  describe('sorting', () => {
    it('renders sortable column headers', () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const symbolHeader = screen.getByText('Symbol');
      const nameHeader = screen.getByText('Name');
      const typeHeader = screen.getByText('Type');
      expect(symbolHeader.closest('th')).toBeInTheDocument();
      expect(nameHeader.closest('th')).toBeInTheDocument();
      expect(typeHeader.closest('th')).toBeInTheDocument();
    });

    it('calls onSort when a sortable column header is clicked', () => {
      const onSort = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onSort={onSort} sortField="symbol" sortDirection="asc" />);
      fireEvent.click(screen.getByText('Name'));
      expect(onSort).toHaveBeenCalledWith('name');
    });

    it('calls onSort with current field to toggle direction', () => {
      const onSort = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onSort={onSort} sortField="symbol" sortDirection="asc" />);
      fireEvent.click(screen.getByText('Symbol'));
      expect(onSort).toHaveBeenCalledWith('symbol');
    });

    it('uses local sort state when no onSort prop is provided', () => {
      const securities = [
        makeSecurity({ id: 's1', symbol: 'AAPL', name: 'Apple Inc.' }),
        makeSecurity({ id: 's2', symbol: 'MSFT', name: 'Microsoft Corp.' }),
      ];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      // Click Name header to sort - should not throw
      fireEvent.click(screen.getByText('Name'));
    });

    it('calls onSort with "shares" when the Shares header is clicked', () => {
      const onSort = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onSort={onSort} sortField="symbol" sortDirection="asc" />);
      fireEvent.click(screen.getByText('Shares'));
      expect(onSort).toHaveBeenCalledWith('shares');
    });
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

    it('does NOT cancel long press when touch movement is below threshold', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
        vi.advanceTimersByTime(200);
        // Move within the threshold (5px delta, threshold is 10px)
        fireEvent.touchMove(row, { touches: [{ clientX: 105, clientY: 102 }] });
        vi.advanceTimersByTime(600);
      });

      // Context menu SHOULD appear because movement was within threshold
      expect(screen.getByText('Edit Security')).toBeInTheDocument();
    });

    it('handles touchStart without touches array gracefully', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        // Fire touchStart without touches - exercises null guard
        fireEvent.touchStart(row, { touches: [] });
        vi.advanceTimersByTime(750);
      });

      // Context menu should appear (no touch position stored, just timer based)
      expect(screen.getByText('Edit Security')).toBeInTheDocument();
    });

    it('touch end cancels the long press timer', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 100 }] });
        vi.advanceTimersByTime(200);
        fireEvent.touchEnd(row);
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });
  });

  describe('onViewPrices', () => {
    it('shows Prices button in row when onViewPrices provided', () => {
      const onViewPrices = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onViewPrices={onViewPrices} />);
      expect(screen.getByText('Prices')).toBeInTheDocument();
    });

    it('calls onViewPrices when Prices button clicked', () => {
      const onViewPrices = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onViewPrices={onViewPrices} />);
      fireEvent.click(screen.getByText('Prices'));
      expect(onViewPrices).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('shows the prices icon button in dense mode when onViewPrices provided', () => {
      const onViewPrices = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onViewPrices={onViewPrices} density="dense" />);
      expect(screen.getByRole('button', { name: 'Prices' })).toBeInTheDocument();
    });

    it('does not show Prices button when onViewPrices not provided', () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      expect(screen.queryByText('Prices')).not.toBeInTheDocument();
    });
  });

  describe('onDelete', () => {
    it('shows Delete button when security has no holdings and no transactions', () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('calls onDelete when Delete button clicked', () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      fireEvent.click(screen.getByText('Delete'));
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('hides Delete button when security has holdings even if onDelete provided', () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];
      const holdings = { s1: 10 };

      render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('hides Delete button when security has transactions even if onDelete provided', () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];
      const transactionSecurityIds = new Set(['s1']);

      render(<SecurityList securities={securities} transactionSecurityIds={transactionSecurityIds} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('does not show Delete button when onDelete not provided', () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });
  });

  describe('lastPriceSource badges in normal density', () => {
    it('renders Yahoo price source badge', () => {
      const securities = [makeSecurity({ lastPriceSource: 'yahoo_finance' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      // Yahoo appears as Provider badge (from quoteProvider=null→default yahoo) AND as lastPriceSource badge
      const yahooEls = screen.getAllByText('Yahoo');
      expect(yahooEls.length).toBeGreaterThanOrEqual(1);
    });

    it('renders MSN price source badge', () => {
      const securities = [makeSecurity({ lastPriceSource: 'msn_finance', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('MSN')).toBeInTheDocument();
    });

    it('renders Manual price source badge', () => {
      const securities = [makeSecurity({ lastPriceSource: 'manual', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Manual')).toBeInTheDocument();
    });

    it('renders Txn badge for buy source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'buy', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Txn')).toBeInTheDocument();
    });

    it('renders Txn badge for sell source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'sell', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Txn')).toBeInTheDocument();
    });

    it('renders Txn badge for reinvest source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'reinvest', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Txn')).toBeInTheDocument();
    });

    it('renders Txn badge for transfer_in source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'transfer_in', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Txn')).toBeInTheDocument();
    });

    it('renders Txn badge for transfer_out source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'transfer_out', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Txn')).toBeInTheDocument();
    });

    it('renders raw source string for unknown source', () => {
      const securities = [makeSecurity({ lastPriceSource: 'some_other_feed', quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('some_other_feed')).toBeInTheDocument();
    });

    it('renders dash when lastPriceSource is null', () => {
      const securities = [makeSecurity({ lastPriceSource: null, quoteProvider: 'yahoo' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      // Source column shows "-" when null
      expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('density button label and row striping', () => {
    it('shows Compact label on density button in compact mode', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="compact" />);
      expect(screen.getByText('Compact')).toBeInTheDocument();
    });

    it('shows Dense label on density button in dense mode', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
      expect(screen.getByText('Dense')).toBeInTheDocument();
    });

    it('applies striped row background for odd-index rows in compact density', () => {
      const securities = [
        makeSecurity({ id: 's1', symbol: 'AAPL' }),
        makeSecurity({ id: 's2', symbol: 'MSFT' }),
      ];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="compact" />);
      const rows = screen.getAllByRole('row');
      // rows[0] = header, rows[1] = index 0 (no stripe), rows[2] = index 1 (stripe)
      expect(rows[2].className).toContain('bg-gray-50');
    });
  });

  describe('sorting with local state', () => {
    it('toggles sort direction when same field clicked twice', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);

      // Click Symbol once to sort asc (already default), click again to toggle desc
      const symbolHeader = screen.getByText('Symbol').closest('th')!;
      fireEvent.click(symbolHeader);
      // Should not throw - exercises the toggle direction branch
      fireEvent.click(symbolHeader);
    });

    it('clicks Exchange header in normal density', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      const exchangeHeader = screen.getByText('Exchange').closest('th')!;
      fireEvent.click(exchangeHeader);
    });

    it('clicks Currency header in normal density', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      const currencyHeader = screen.getByText('Currency').closest('th')!;
      fireEvent.click(currencyHeader);
    });

    it('clicks Provider header in normal density', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      const providerHeader = screen.getByText('Provider').closest('th')!;
      fireEvent.click(providerHeader);
    });

    it('clicks Source header in normal density', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      const sourceHeader = screen.getByText('Source').closest('th')!;
      fireEvent.click(sourceHeader);
    });
  });

  describe('context menu with onViewPrices and onDelete', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows View Prices in context menu when onViewPrices provided', async () => {
      const onViewPrices = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onViewPrices={onViewPrices} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('View Prices')).toBeInTheDocument();
    });

    it('calls onViewPrices from context menu', async () => {
      const onViewPrices = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onViewPrices={onViewPrices} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      fireEvent.click(screen.getByText('View Prices'));
      expect(onViewPrices).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('shows Delete in context menu when security can be deleted', async () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getAllByText('Delete').length).toBeGreaterThanOrEqual(1);
    });

    it('calls onDelete from context menu', async () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // The last Delete button is the one in the context menu (row Delete is not shown since inline Delete is controlled)
      const deleteButtons = screen.getAllByText('Delete');
      fireEvent.click(deleteButtons[deleteButtons.length - 1]);
      expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
    });

    it('hides Delete in context menu when security has holdings', async () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];
      const holdings = { s1: 5 };

      render(<SecurityList securities={securities} holdings={holdings} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Edit Security shown but no Delete
      expect(screen.getByText('Edit Security')).toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('hides Delete in context menu when security has transactions', async () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];
      const transactionSecurityIds = new Set(['s1']);

      render(<SecurityList securities={securities} transactionSecurityIds={transactionSecurityIds} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Security')).toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('shows Activate in context menu for inactive security without holdings', async () => {
      const securities = [makeSecurity({ isActive: false })];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      // Both the inline button and context menu show Activate
      const activateButtons = screen.getAllByText('Activate');
      expect(activateButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('calls onToggleActive from context menu for inactive security', async () => {
      const securities = [makeSecurity({ isActive: false })];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      const activateButtons = screen.getAllByText('Activate');
      fireEvent.click(activateButtons[activateButtons.length - 1]);
      expect(onToggleActive).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    });

    it('context menu closes when modal onClose is triggered', async () => {
      const securities = [makeSecurity()];

      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const row = screen.getByText('AAPL').closest('tr')!;

      await act(async () => {
        fireEvent.mouseDown(row);
        vi.advanceTimersByTime(750);
      });

      expect(screen.getByText('Edit Security')).toBeInTheDocument();

      // Press Escape to close modal
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      expect(screen.queryByText('Edit Security')).not.toBeInTheDocument();
    });
  });

  describe('security type full labels in normal density', () => {
    it('renders STOCK full label', () => {
      const securities = [makeSecurity({ securityType: 'STOCK' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Stock')).toBeInTheDocument();
    });

    it('renders BOND full label', () => {
      const securities = [makeSecurity({ securityType: 'BOND' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Bond')).toBeInTheDocument();
    });

    it('renders OPTION full label', () => {
      const securities = [makeSecurity({ securityType: 'OPTION' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Option')).toBeInTheDocument();
    });

    it('renders CRYPTO full label', () => {
      const securities = [makeSecurity({ securityType: 'CRYPTO' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Crypto')).toBeInTheDocument();
    });

    it('renders OTHER full label', () => {
      const securities = [makeSecurity({ securityType: 'OTHER' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('Other')).toBeInTheDocument();
    });

    it('renders unknown security type as-is', () => {
      const securities = [makeSecurity({ securityType: 'CUSTOM_TYPE' })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="normal" />);
      expect(screen.getByText('CUSTOM_TYPE')).toBeInTheDocument();
    });
  });

  describe('dense mode action labels', () => {
    it('shows pencil icon in Edit button in dense mode', () => {
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
      // Dense mode renders '✎' instead of 'Edit'
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('shows deactivate icon in dense mode for active security', () => {
      const securities = [makeSecurity({ isActive: true })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
      expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    });

    it('shows activate icon in dense mode for inactive security', () => {
      const securities = [makeSecurity({ isActive: false })];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} density="dense" />);
      expect(screen.queryByText('Activate')).not.toBeInTheDocument();
    });

    it('shows delete icon in dense mode when security can be deleted', () => {
      const onDelete = vi.fn();
      const securities = [makeSecurity()];
      render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} onDelete={onDelete} density="dense" />);
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });
  });

  describe('favourite column', () => {
    it('renders an "Add to favourites" star for a non-favourite security', () => {
      render(<SecurityList securities={[makeSecurity()]} onEdit={onEdit} onToggleActive={onToggleActive} />);
      expect(screen.getByTitle('Add to favourites')).toBeInTheDocument();
    });

    it('renders a filled star (Remove from favourites) for a favourite security', () => {
      render(<SecurityList securities={[makeSecurity({ isFavourite: true })]} onEdit={onEdit} onToggleActive={onToggleActive} />);
      const btn = screen.getByTitle('Remove from favourites');
      expect(btn).toBeInTheDocument();
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });

    it('calls onToggleFavourite with the security when the star is clicked', () => {
      const onToggleFavourite = vi.fn();
      render(
        <SecurityList
          securities={[makeSecurity()]}
          onEdit={onEdit}
          onToggleActive={onToggleActive}
          onToggleFavourite={onToggleFavourite}
        />,
      );
      fireEvent.click(screen.getByTitle('Add to favourites'));
      expect(onToggleFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });

    it('does not invoke other row handlers when the star is clicked', () => {
      const onToggleFavourite = vi.fn();
      render(
        <SecurityList
          securities={[makeSecurity()]}
          onEdit={onEdit}
          onToggleActive={onToggleActive}
          onToggleFavourite={onToggleFavourite}
        />,
      );
      fireEvent.click(screen.getByTitle('Add to favourites'));
      expect(onEdit).not.toHaveBeenCalled();
      expect(onToggleActive).not.toHaveBeenCalled();
    });
  });
});
