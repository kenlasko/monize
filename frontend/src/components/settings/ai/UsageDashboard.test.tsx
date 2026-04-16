import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import type { AiUsageSummary, AiProviderConfig } from '@/types/ai';

// Mock the stores/hooks the dashboard reads for currency conversion.
// By default the user's home currency is USD and conversion is 1:1, so the
// tests that don't care about conversion behave the same as before.
let mockHomeCurrency = 'USD';
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ preferences: { defaultCurrency: mockHomeCurrency } }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convert: (amount: number, from: string, to?: string) => {
      if (!to || from === to) return amount;
      // Simple fake rate: EUR->USD = 1.1.
      if (from === 'EUR' && to === 'USD') return amount * 1.1;
      if (from === 'USD' && to === 'EUR') return amount / 1.1;
      return amount;
    },
    defaultCurrency: mockHomeCurrency,
  }),
}));

// Import after mocks are registered.
import { UsageDashboard } from './UsageDashboard';

const noConfigs: AiProviderConfig[] = [];

function makeConfig(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'config-1',
    provider: 'anthropic',
    displayName: null,
    isActive: true,
    priority: 0,
    model: null,
    apiKeyMasked: null,
    baseUrl: null,
    config: {},
    inputCostPer1M: null,
    outputCostPer1M: null,
    costCurrency: 'USD',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const emptyUsage: AiUsageSummary = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedCostByCurrency: {},
  byProvider: [],
  byFeature: [],
  recentLogs: [],
};

const populatedUsage: AiUsageSummary = {
  totalRequests: 42,
  totalInputTokens: 5000,
  totalOutputTokens: 2500,
  totalEstimatedCostByCurrency: { USD: 12.34 },
  byProvider: [
    {
      provider: 'anthropic',
      requests: 30,
      inputTokens: 3500,
      outputTokens: 1800,
      estimatedCostByCurrency: { USD: 10 },
    },
    {
      provider: 'openai',
      requests: 12,
      inputTokens: 1500,
      outputTokens: 700,
      estimatedCostByCurrency: { USD: 2.34 },
    },
  ],
  byFeature: [
    {
      feature: 'categorize',
      requests: 25,
      inputTokens: 3000,
      outputTokens: 1500,
      estimatedCostByCurrency: { USD: 8.5 },
    },
  ],
  recentLogs: [
    {
      id: 'log-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      feature: 'categorize',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1200,
      estimatedCost: 0.0012,
      costCurrency: 'USD',
      createdAt: '2024-06-15T12:00:00.000Z',
    },
  ],
};

describe('UsageDashboard', () => {
  const onPeriodChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockHomeCurrency = 'USD';
  });

  it('renders summary cards', () => {
    render(<UsageDashboard usage={populatedUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('Total Requests')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('2,500')).toBeInTheDocument();
  });

  it('renders period selector buttons', () => {
    render(<UsageDashboard usage={emptyUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
  });

  it('calls onPeriodChange when period button clicked', () => {
    render(<UsageDashboard usage={emptyUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    fireEvent.click(screen.getByText('7 days'));
    expect(onPeriodChange).toHaveBeenCalledWith(7);
  });

  it('renders by-provider table with friendly labels when no display name is configured', () => {
    render(<UsageDashboard usage={populatedUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('By Provider')).toBeInTheDocument();
    expect(screen.getAllByText('Anthropic (Claude)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('OpenAI (GPT)')).toBeInTheDocument();
  });

  it('uses display name from configured provider when available', () => {
    const configs = [
      makeConfig({
        id: 'c-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        displayName: 'My Claude API',
      }),
    ];
    render(<UsageDashboard usage={populatedUsage} configs={configs} onPeriodChange={onPeriodChange} />);
    expect(screen.getAllByText('My Claude API').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('OpenAI (GPT)')).toBeInTheDocument();
  });

  it('falls back to provider label when multiple configs share a provider type', () => {
    const configs = [
      makeConfig({ id: 'c-1', provider: 'anthropic', model: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet' }),
      makeConfig({ id: 'c-2', provider: 'anthropic', model: 'claude-haiku-4-20250414', displayName: 'Claude Haiku' }),
    ];
    render(<UsageDashboard usage={populatedUsage} configs={configs} onPeriodChange={onPeriodChange} />);
    expect(screen.getAllByText('Anthropic (Claude)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  });

  it('renders recent activity table when logs exist', () => {
    render(<UsageDashboard usage={populatedUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    expect(screen.getByText('categorize')).toBeInTheDocument();
    expect(screen.getByText('1200ms')).toBeInTheDocument();
  });

  it('shows empty state when no usage data', () => {
    render(<UsageDashboard usage={emptyUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText(/no usage data yet/i)).toBeInTheDocument();
  });

  it('shows estimated cost in summary card', () => {
    render(<UsageDashboard usage={populatedUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    // "Est. Cost" appears in the summary card and in each table header, so assert at least one exists.
    expect(screen.getAllByText('Est. Cost').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('$12.34')).toBeInTheDocument();
  });

  it('shows dash for estimated cost when no rates configured', () => {
    render(<UsageDashboard usage={emptyUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText(/set rates on a provider/i)).toBeInTheDocument();
  });

  it('does not show provider table when empty', () => {
    render(<UsageDashboard usage={emptyUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.queryByText('By Provider')).not.toBeInTheDocument();
  });

  it('does not show the currency toggle when all costs are in the home currency', () => {
    render(<UsageDashboard usage={populatedUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);
    expect(screen.queryByText(/In provider currency/i)).not.toBeInTheDocument();
  });

  it('shows the currency toggle and switches between home and provider currency', () => {
    const foreignUsage: AiUsageSummary = {
      ...populatedUsage,
      totalEstimatedCostByCurrency: { EUR: 10 },
      byProvider: [
        {
          provider: 'anthropic',
          requests: 30,
          inputTokens: 3500,
          outputTokens: 1800,
          estimatedCostByCurrency: { EUR: 10 },
        },
      ],
      recentLogs: [],
    };
    render(<UsageDashboard usage={foreignUsage} configs={noConfigs} onPeriodChange={onPeriodChange} />);

    // Home currency (USD) mode is the default: EUR 10 -> USD 11 via the fake rate.
    // Appears in both the summary card and the byProvider row.
    expect(screen.getAllByText('$11.00').length).toBeGreaterThanOrEqual(1);

    // Switch to provider currency and assert euros now show up.
    fireEvent.click(screen.getByText('In provider currency'));
    expect(screen.getAllByText(/€\s?10\.00/).length).toBeGreaterThanOrEqual(1);
  });
});
