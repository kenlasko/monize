import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { UpcomingBillsReport } from './UpcomingBillsReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const mockGetAll = vi.fn();

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('UpcomingBillsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<UpcomingBillsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no scheduled transactions', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText(/No scheduled bills found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards and view controls with data', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const futureDateStr = futureDate.toISOString().split('T')[0];

    mockGetAll.mockResolvedValue([
      {
        id: 'st-1',
        name: 'Rent',
        amount: -1500,
        frequency: 'MONTHLY',
        nextDueDate: futureDateStr,
        isActive: true,
        isTransfer: false,
        autoPost: true,
        payee: { name: 'Landlord' },
        payeeName: 'Landlord',
      },
    ]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Active Bills')).toBeInTheDocument();
    });
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('List')).toBeInTheDocument();
  });

  it('renders month navigation', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<UpcomingBillsReport />);
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });
});
