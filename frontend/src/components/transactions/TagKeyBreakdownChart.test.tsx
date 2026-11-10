import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@/test/render';
import { TagKeyBreakdownChart } from './TagKeyBreakdownChart';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getTagKeyBreakdown: vi.fn(),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (val: number, currency: string) =>
        `${currency} ${val.toFixed(2)}`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
  }),
}));

import { transactionsApi } from '@/lib/transactions';

const mocked = vi.mocked(transactionsApi);

describe('TagKeyBreakdownChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one slice per value with shares of the charted total', async () => {
    mocked.getTagKeyBreakdown.mockResolvedValue([
      { id: 'usa', name: 'usa', currencyCode: 'CAD', total: 200, count: 2 },
      { id: 'poland', name: 'poland', currencyCode: 'CAD', total: 100, count: 1 },
    ]);

    await act(async () => {
      render(<TagKeyBreakdownChart tagKey="country" params={{}} />);
    });

    await waitFor(() => {
      expect(screen.getByText('usa')).toBeInTheDocument();
    });
    expect(screen.getByText('poland')).toBeInTheDocument();
    // usa 200 / 300 = 66.7%, poland 100 / 300 = 33.3%
    expect(screen.getByText('66.7%')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();

    // The requested key is forwarded to the API.
    expect(mocked.getTagKeyBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'country' }),
    );
  });

  it("charts several currencies at the server's per-date conversion (issue #2106)", async () => {
    // At a flat 1:1 the USD value would be 200 and the shares 66.7% / 33.3%;
    // the server converted it at each transaction's own date to 300 CAD.
    mocked.getTagKeyBreakdown.mockResolvedValue([
      { id: 'usa', name: 'usa', currencyCode: 'USD', total: 200, count: 2, convertedCurrency: 'CAD', convertedTotal: 300 },
      { id: 'poland', name: 'poland', currencyCode: 'CAD', total: 100, count: 1, convertedCurrency: 'CAD', convertedTotal: 100 },
    ]);

    await act(async () => {
      render(<TagKeyBreakdownChart tagKey="country" params={{}} />);
    });

    await waitFor(() => {
      expect(screen.getByText('75.0%')).toBeInTheDocument();
    });
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });

  it('shows the empty state when there is nothing to break down', async () => {
    mocked.getTagKeyBreakdown.mockResolvedValue([]);

    await act(async () => {
      render(<TagKeyBreakdownChart tagKey="country" params={{}} />);
    });

    await waitFor(() => {
      expect(
        screen.getByText('No tagged spending to break down for this key.'),
      ).toBeInTheDocument();
    });
  });
});
