import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Account } from '@/types/account';
import { HoldingWithMarketValue } from '@/types/investment';
import { SecurityTypeAllocationWidget } from './SecurityTypeAllocationWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

// Stable config reference across renders (mirrors the real memoized hook), so
// useReportData's [config.accountIds] dependency does not change every render.
const { widgetCfg } = vi.hoisted(() => ({
  widgetCfg: { config: { accountIds: [] as string[] }, updateConfig: () => {} },
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => widgetCfg,
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (n: number) => `$${n}` }),
}));
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ convertToDefault: (n: number) => n }),
}));

const getPortfolioSummary = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a) },
}));

const holding = (securityId: string, securityType: string, marketValue: number): HoldingWithMarketValue =>
  ({
    securityId,
    securityType,
    marketValue,
    currencyCode: 'USD',
    quantity: 10,
    costBasis: marketValue,
    costBasisAccountCurrency: marketValue,
    averageCost: marketValue / 10,
    gainLoss: 0,
    gainLossPercent: 0,
  }) as HoldingWithMarketValue;

const investmentAccount = { id: 'i1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', name: 'Brokerage' } as Account;

async function renderWidget() {
  await act(async () => {
    render(<SecurityTypeAllocationWidget accounts={[investmentAccount]} isLoading={false} />);
  });
}

describe('SecurityTypeAllocationWidget', () => {
  beforeEach(() => getPortfolioSummary.mockReset());

  it('groups holdings by security type', async () => {
    getPortfolioSummary.mockResolvedValue({
      holdings: [holding('s1', 'STOCK', 700), holding('s2', 'ETF', 300)],
      holdingsByAccount: [],
    });
    await renderWidget();
    expect(screen.getByText('Security Type Allocation')).toBeInTheDocument();
    expect(screen.getByText('Stocks')).toBeInTheDocument();
    expect(screen.getByText('ETFs')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state with no holdings', async () => {
    getPortfolioSummary.mockResolvedValue({ holdings: [], holdingsByAccount: [] });
    await renderWidget();
    expect(screen.getByText('No holdings to show.')).toBeInTheDocument();
  });
});
