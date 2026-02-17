import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UsageDashboard } from './UsageDashboard';
import type { AiUsageSummary } from '@/types/ai';

const emptyUsage: AiUsageSummary = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  byProvider: [],
  byFeature: [],
  recentLogs: [],
};

const populatedUsage: AiUsageSummary = {
  totalRequests: 42,
  totalInputTokens: 5000,
  totalOutputTokens: 2500,
  byProvider: [
    { provider: 'anthropic', requests: 30, inputTokens: 3500, outputTokens: 1800 },
    { provider: 'openai', requests: 12, inputTokens: 1500, outputTokens: 700 },
  ],
  byFeature: [
    { feature: 'categorize', requests: 25, inputTokens: 3000, outputTokens: 1500 },
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
      createdAt: '2024-06-15T12:00:00.000Z',
    },
  ],
};

describe('UsageDashboard', () => {
  const onPeriodChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders summary cards', () => {
    render(<UsageDashboard usage={populatedUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('Total Requests')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('2,500')).toBeInTheDocument();
  });

  it('renders period selector buttons', () => {
    render(<UsageDashboard usage={emptyUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
  });

  it('calls onPeriodChange when period button clicked', () => {
    render(<UsageDashboard usage={emptyUsage} onPeriodChange={onPeriodChange} />);
    fireEvent.click(screen.getByText('7 days'));
    expect(onPeriodChange).toHaveBeenCalledWith(7);
  });

  it('renders by-provider table when data exists', () => {
    render(<UsageDashboard usage={populatedUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('By Provider')).toBeInTheDocument();
    expect(screen.getAllByText('anthropic').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('openai')).toBeInTheDocument();
  });

  it('renders recent activity table when logs exist', () => {
    render(<UsageDashboard usage={populatedUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText('Recent Activity')).toBeInTheDocument();
    expect(screen.getByText('categorize')).toBeInTheDocument();
    expect(screen.getByText('1200ms')).toBeInTheDocument();
  });

  it('shows empty state when no usage data', () => {
    render(<UsageDashboard usage={emptyUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.getByText(/no usage data yet/i)).toBeInTheDocument();
  });

  it('does not show provider table when empty', () => {
    render(<UsageDashboard usage={emptyUsage} onPeriodChange={onPeriodChange} />);
    expect(screen.queryByText('By Provider')).not.toBeInTheDocument();
  });
});
