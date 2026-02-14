import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentTransactionList } from './InvestmentTransactionList';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    numberFormat: 'en-US',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
  }),
}));

describe('InvestmentTransactionList', () => {
  const makeTx = (overrides: any = {}) => ({
    id: 't1', action: 'BUY', transactionDate: '2024-01-15',
    security: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'CAD' },
    quantity: 10, price: 150, totalAmount: 1500,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    render(<InvestmentTransactionList transactions={[]} isLoading={true} />);
    expect(screen.getByText('Recent Transactions')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<InvestmentTransactionList transactions={[]} isLoading={false} />);
    expect(screen.getByText('No investment transactions yet.')).toBeInTheDocument();
  });

  it('renders transactions table', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
  });

  it('shows New Transaction button when callback provided', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} onNewTransaction={vi.fn()} />);
    expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
  });

  it('shows New Transaction button in empty state when callback provided', () => {
    render(<InvestmentTransactionList transactions={[]} isLoading={false} onNewTransaction={vi.fn()} />);
    expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
  });

  it('calls onNewTransaction when button is clicked', () => {
    const onNewTransaction = vi.fn();
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} onNewTransaction={onNewTransaction} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    expect(onNewTransaction).toHaveBeenCalled();
  });

  it('renders table headers', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows Actions column when onDelete or onEdit provided', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} onDelete={vi.fn()} />);
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('does not show Actions column when no callbacks', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('shows Edit and Delete buttons for transactions', () => {
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls onEdit when Edit button is clicked', () => {
    const onEdit = vi.fn();
    const tx = makeTx();
    render(
      <InvestmentTransactionList
        transactions={[tx] as any[]}
        isLoading={false}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });

  it('shows delete confirmation dialog when Delete is clicked', () => {
    const onDelete = vi.fn();
    const tx = makeTx();
    render(
      <InvestmentTransactionList
        transactions={[tx] as any[]}
        isLoading={false}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
  });

  it('calls onDelete when confirming delete', () => {
    const onDelete = vi.fn();
    const tx = makeTx();
    render(
      <InvestmentTransactionList
        transactions={[tx] as any[]}
        isLoading={false}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByText('Delete'));
    // Confirm in the dialog
    const confirmButtons = screen.getAllByText('Delete');
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(onDelete).toHaveBeenCalledWith('t1');
  });

  it('closes delete dialog on cancel', () => {
    const onDelete = vi.fn();
    const tx = makeTx();
    render(
      <InvestmentTransactionList
        transactions={[tx] as any[]}
        isLoading={false}
        onDelete={onDelete}
      />
    );
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('cycles density on button click', () => {
    const transactions = [makeTx()] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('Normal')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Normal'));
    expect(screen.getByText('Compact')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Compact'));
    expect(screen.getByText('Dense')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dense'));
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('calls onDensityChange prop when cycling density', () => {
    const onDensityChange = vi.fn();
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        density="normal"
        onDensityChange={onDensityChange}
      />
    );
    fireEvent.click(screen.getByText('Normal'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('shows filter button when onFiltersChange provided', () => {
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        onFiltersChange={vi.fn()}
      />
    );
    expect(screen.getByText('Filter')).toBeInTheDocument();
  });

  it('toggles filter bar on filter button click', () => {
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        onFiltersChange={vi.fn()}
        availableSymbols={['AAPL', 'MSFT']}
      />
    );
    fireEvent.click(screen.getByText('Filter'));
    expect(screen.getByText('Symbol:')).toBeInTheDocument();
    expect(screen.getByText('Action:')).toBeInTheDocument();
    expect(screen.getByText('From:')).toBeInTheDocument();
    expect(screen.getByText('To:')).toBeInTheDocument();
  });

  it('shows "(filtered)" and active filter count when filters are active', () => {
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        onFiltersChange={vi.fn()}
        filters={{ symbol: 'AAPL' }}
      />
    );
    expect(screen.getByText('(filtered)')).toBeInTheDocument();
  });

  it('shows Clear Filters button when filters are active', () => {
    const onFiltersChange = vi.fn();
    const transactions = [makeTx()] as any[];
    render(
      <InvestmentTransactionList
        transactions={transactions}
        isLoading={false}
        onFiltersChange={onFiltersChange}
        filters={{ symbol: 'AAPL' }}
      />
    );
    // Open filter bar
    fireEvent.click(screen.getByText('Filter'));
    fireEvent.click(screen.getByText('Clear Filters'));
    expect(onFiltersChange).toHaveBeenCalledWith({});
  });

  it('renders different action labels correctly', () => {
    const transactions = [
      makeTx({ id: 't1', action: 'SELL' }),
      makeTx({ id: 't2', action: 'DIVIDEND' }),
      makeTx({ id: 't3', action: 'INTEREST', security: null }),
    ] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Dividend')).toBeInTheDocument();
    expect(screen.getByText('Interest')).toBeInTheDocument();
  });

  it('shows dash for missing security symbol', () => {
    const transactions = [makeTx({ security: null })] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows foreign currency indicator for non-default currencies', () => {
    const transactions = [makeTx({
      security: { symbol: 'AAPL', name: 'Apple', currencyCode: 'USD' },
    })] as any[];
    render(<InvestmentTransactionList transactions={transactions} isLoading={false} />);
    const usdLabels = screen.getAllByText('USD');
    expect(usdLabels.length).toBeGreaterThan(0);
  });

  it('calls onEdit on row click', () => {
    const onEdit = vi.fn();
    const tx = makeTx();
    render(
      <InvestmentTransactionList
        transactions={[tx] as any[]}
        isLoading={false}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByText('AAPL'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
  });
});
