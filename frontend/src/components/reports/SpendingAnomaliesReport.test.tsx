import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { SpendingAnomaliesReport } from './SpendingAnomaliesReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

const mockGetSpendingAnomalies = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getSpendingAnomalies: (...args: any[]) => mockGetSpendingAnomalies(...args),
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

describe('SpendingAnomaliesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetSpendingAnomalies.mockReturnValue(new Promise(() => {}));
    render(<SpendingAnomaliesReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders no anomalies message when empty', async () => {
    mockGetSpendingAnomalies.mockResolvedValue({
      anomalies: [],
      counts: { high: 0, medium: 0, low: 0 },
    });
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText(/No spending anomalies detected/)).toBeInTheDocument();
    });
  });

  it('renders anomaly cards with data', async () => {
    mockGetSpendingAnomalies.mockResolvedValue({
      anomalies: [
        {
          title: 'Large purchase at Store X',
          description: 'This transaction is 3x the average',
          severity: 'high',
          type: 'large_transaction',
          amount: 500,
          transactionId: 'tx-1',
          payeeName: 'Store X',
        },
      ],
      counts: { high: 1, medium: 0, low: 0 },
    });
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText('Large purchase at Store X')).toBeInTheDocument();
    });
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  it('renders severity summary cards', async () => {
    mockGetSpendingAnomalies.mockResolvedValue({
      anomalies: [],
      counts: { high: 2, medium: 5, low: 3 },
    });
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText('High Priority')).toBeInTheDocument();
    });
    expect(screen.getByText('Medium Priority')).toBeInTheDocument();
    expect(screen.getByText('Low Priority')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders medium and low severity anomalies', async () => {
    mockGetSpendingAnomalies.mockResolvedValue({
      anomalies: [
        {
          title: 'Category spike in Dining',
          description: 'Spending increased by 150%',
          severity: 'medium',
          type: 'category_spike',
          categoryId: 'cat-1',
          currentPeriodAmount: 500,
          previousPeriodAmount: 200,
        },
        {
          title: 'New payee detected',
          description: 'First time transaction with Store Y',
          severity: 'low',
          type: 'unusual_payee',
          amount: 75,
          transactionId: 'tx-2',
          payeeName: 'Store Y',
        },
      ],
      counts: { high: 0, medium: 1, low: 1 },
    });
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText('Category spike in Dining')).toBeInTheDocument();
    });
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.getByText('low')).toBeInTheDocument();
    expect(screen.getByText('New payee detected')).toBeInTheDocument();
    // Category spike details
    expect(screen.getByText(/Last month/)).toBeInTheDocument();
    expect(screen.getByText(/This month/)).toBeInTheDocument();
  });

  it('renders sensitivity selector', async () => {
    mockGetSpendingAnomalies.mockResolvedValue({
      anomalies: [],
      counts: { high: 0, medium: 0, low: 0 },
    });
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText('Sensitivity:')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully', async () => {
    mockGetSpendingAnomalies.mockRejectedValue(new Error('Network error'));
    render(<SpendingAnomaliesReport />);
    await waitFor(() => {
      expect(screen.getByText('High Priority')).toBeInTheDocument();
    });
  });
});
