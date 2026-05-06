import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { InsightsWidget } from './InsightsWidget';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const getInsightsMock = vi.fn();
vi.mock('@/lib/ai', () => ({
  aiApi: {
    getInsights: (...args: unknown[]) => getInsightsMock(...args),
  },
}));

async function renderWidget(parentLoading = false) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<InsightsWidget isLoading={parentLoading} />);
  });
  return result!;
}

const sampleInsights = [
  { id: '1', title: 'Insight 1', description: 'Big spend in groceries', severity: 'alert', type: 'spending' },
  { id: '2', title: 'Insight 2', description: 'Saved more this month', severity: 'info', type: 'spending' },
  { id: '3', title: 'Insight 3', description: 'Income up', severity: 'warning', type: 'income' },
  { id: '4', title: 'Insight 4', description: 'Should not appear', severity: 'unknown-severity', type: 'spending' },
];

describe('InsightsWidget', () => {
  beforeEach(() => {
    pushMock.mockReset();
    getInsightsMock.mockReset();
  });

  it('renders parent-loading skeleton without calling API', async () => {
    getInsightsMock.mockResolvedValue({ insights: [] });
    await renderWidget(true);
    expect(getInsightsMock).not.toHaveBeenCalled();
    expect(screen.getByText('Spending Insights')).toBeInTheDocument();
  });

  it('renders insights and navigates on click', async () => {
    getInsightsMock.mockResolvedValue({ insights: sampleInsights });
    await renderWidget(false);

    expect(screen.getByText('Insight 1')).toBeInTheDocument();
    expect(screen.getByText('Insight 2')).toBeInTheDocument();
    expect(screen.getByText('Insight 3')).toBeInTheDocument();
    expect(screen.queryByText('Insight 4')).not.toBeInTheDocument();
    expect(screen.getByText('3 active')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Spending Insights'));
    });
    expect(pushMock).toHaveBeenCalledWith('/insights');

    await act(async () => {
      fireEvent.click(screen.getByText('View all insights'));
    });
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it('renders empty state when no insights', async () => {
    getInsightsMock.mockResolvedValue({ insights: [] });
    await renderWidget(false);
    expect(screen.getByText(/No insights available/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('Go to Insights'));
    });
    expect(pushMock).toHaveBeenCalledWith('/insights');
  });

  it('handles API error silently', async () => {
    getInsightsMock.mockRejectedValue(new Error('boom'));
    await renderWidget(false);
    // Falls into empty state
    expect(screen.getByText(/No insights available/)).toBeInTheDocument();
  });
});
