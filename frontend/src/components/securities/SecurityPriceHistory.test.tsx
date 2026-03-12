import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SecurityPriceHistory } from './SecurityPriceHistory';

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityPrices: vi.fn(),
    createSecurityPrice: vi.fn(),
    updateSecurityPrice: vi.fn(),
    deleteSecurityPrice: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    dateFormat: 'browser',
  }),
}));

const { investmentsApi } = await import('@/lib/investments');

const mockSecurity = {
  id: 'sec-1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
  isActive: true,
  skipPriceUpdates: false,
  sector: null,
  industry: null,
  sectorWeightings: null,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const mockPrices = [
  {
    id: 1,
    securityId: 'sec-1',
    priceDate: '2025-06-01',
    openPrice: 190,
    highPrice: 195,
    lowPrice: 189,
    closePrice: 193.5,
    volume: 50000000,
    source: 'yahoo_finance',
    createdAt: '2025-06-01T17:00:00Z',
  },
  {
    id: 2,
    securityId: 'sec-1',
    priceDate: '2025-05-30',
    openPrice: null,
    highPrice: null,
    lowPrice: null,
    closePrice: 150.25,
    volume: null,
    source: 'buy',
    createdAt: '2025-05-30T10:00:00Z',
  },
  {
    id: 3,
    securityId: 'sec-1',
    priceDate: '2025-05-29',
    openPrice: 145,
    highPrice: 148,
    lowPrice: 144,
    closePrice: 147,
    volume: 1000,
    source: 'manual',
    createdAt: '2025-05-29T10:00:00Z',
  },
];

describe('SecurityPriceHistory', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue(mockPrices);
  });

  async function renderComponent() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<SecurityPriceHistory security={mockSecurity} onClose={onClose} />);
    });
    return result!;
  }

  it('renders price history with source badges', async () => {
    await renderComponent();

    expect(screen.getByText('AAPL - Price History')).toBeInTheDocument();
    expect(screen.getByText('Yahoo')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('shows empty state when no prices', async () => {
    (investmentsApi.getSecurityPrices as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await renderComponent();

    expect(screen.getByText('No price history available')).toBeInTheDocument();
  });

  it('shows add price form when button clicked', async () => {
    await renderComponent();

    await act(async () => {
      fireEvent.click(screen.getByText('+ Add Price'));
    });

    // "Add Price" appears as both the section header and form button
    expect(screen.getAllByText('Add Price').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('Close Price')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', async () => {
    await renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders edit and delete buttons for each row', async () => {
    await renderComponent();

    const editButtons = screen.getAllByText('Edit');
    const deleteButtons = screen.getAllByText('Delete');
    expect(editButtons).toHaveLength(3);
    expect(deleteButtons).toHaveLength(3);
  });
});
