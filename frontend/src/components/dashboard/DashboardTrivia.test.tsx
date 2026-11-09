import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@/test/render';
import { DashboardTrivia, TRIVIA_ROTATE_MS } from './DashboardTrivia';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

const get = vi.fn();
vi.mock('@/lib/dashboard-trivia', () => ({
  dashboardTriviaApi: { get: () => get() },
}));

const list = (over: Partial<DashboardTriviaResponse>): DashboardTriviaResponse => ({
  items: [],
  figures: {},
  generatedAt: '2026-11-09T06:30:00.000Z',
  ...over,
});

const show = async (topic: 'netWorth' | 'investments' = 'netWorth') => {
  await act(async () => {
    render(<DashboardTrivia topic={topic} />);
  });
};

describe('DashboardTrivia', () => {
  beforeEach(() => {
    get.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a calculated fact from the catalog with formatted figures', async () => {
    get.mockResolvedValue(
      list({
        items: [{ topic: 'netWorth', source: 'calculated', factId: 'netWorthHighPoint' }],
        figures: {
          peakAmount: { kind: 'money', value: 3913005.98, currency: 'CAD' },
          peakMonth: { kind: 'month', value: '2026-09' },
          peakBelow: { kind: 'money', value: 64910, currency: 'CAD' },
        },
      }),
    );
    await show();
    const line = screen.getByTestId('dashboard-trivia');
    expect(line).toHaveTextContent('Net worth');
    expect(line).toHaveTextContent('Your high point was');
    expect(line).toHaveTextContent('3,913,005.98');
    expect(line).toHaveTextContent('September 2026');
    expect(line.querySelector('svg')).toBeNull();
  });

  it('fills a model sentence from the figures and marks it as AI', async () => {
    get.mockResolvedValue(
      list({
        items: [{ topic: 'investments', source: 'ai', text: 'You hold {name}, up {pct} at {rate} and {multiple}x.' }],
        figures: {
          name: { kind: 'text', value: 'XGRO' },
          pct: { kind: 'percent', value: 12.5 },
          rate: { kind: 'rate', value: 1.4066 },
          multiple: { kind: 'multiple', value: 2.03 },
        },
      }),
    );
    await show('investments');
    const line = screen.getByTestId('dashboard-trivia');
    expect(line).toHaveTextContent('Investments');
    expect(line).toHaveTextContent('You hold XGRO, up 12.50%');
    expect(line).toHaveTextContent('1.4066');
    expect(line).toHaveTextContent('2.03x');
    expect(line.querySelector('title')?.textContent).toBe('Written by AI from your figures');
  });

  it('never renders a model sentence as markup', async () => {
    get.mockResolvedValue(
      list({
        items: [{ topic: 'netWorth', source: 'ai', text: '<img src=x onerror=alert(1)> {a}' }],
        figures: { a: { kind: 'text', value: 'A' } },
      }),
    );
    await show();
    const line = screen.getByTestId('dashboard-trivia');
    expect(line.querySelector('img')).toBeNull();
    expect(line).toHaveTextContent('<img src=x onerror=alert(1)> A');
  });

  const twoTopics = list({
    items: [
      { topic: 'netWorth', source: 'ai', text: 'net one {a}' },
      { topic: 'netWorth', source: 'ai', text: 'net two {a}' },
      { topic: 'investments', source: 'ai', text: 'invest one {a}' },
    ],
    figures: { a: { kind: 'text', value: 'A' } },
  });

  it('shows the facts of the set on screen', async () => {
    get.mockResolvedValue(twoTopics);
    await show('investments');
    expect(screen.getByTestId('dashboard-trivia')).toHaveTextContent('invest one A');
  });

  it('moves to the next sentence on a timer', async () => {
    get.mockResolvedValue(twoTopics);
    await show();
    expect(screen.getByTestId('dashboard-trivia')).toHaveTextContent('net one A');
    await act(async () => vi.advanceTimersByTime(TRIVIA_ROTATE_MS));
    expect(screen.getByTestId('dashboard-trivia')).toHaveTextContent('net two A');
  });

  it('reaches every sentence of a list on Auto, one step per visit', async () => {
    const sentences = ['a', 'b', 'c', 'd'].map((x) => `net ${x} {v}`);
    get.mockResolvedValue(
      list({
        items: [
          ...sentences.map((text) => ({ topic: 'netWorth' as const, source: 'ai' as const, text })),
          { topic: 'investments', source: 'ai', text: 'invest {v}' },
        ],
        figures: { v: { kind: 'text', value: 'V' } },
      }),
    );
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<DashboardTrivia topic="netWorth" heroCycling />);
    });
    const seen = new Set([screen.getByTestId('dashboard-trivia').textContent]);
    for (let i = 0; i < 3; i++) {
      await act(async () => view.rerender(<DashboardTrivia topic="investments" heroCycling />));
      await act(async () => view.rerender(<DashboardTrivia topic="netWorth" heroCycling />));
      seen.add(screen.getByTestId('dashboard-trivia').textContent);
    }
    expect(seen.size).toBe(4);
  });

  it('leaves the pace to the hero while it alternates', async () => {
    get.mockResolvedValue(twoTopics);
    await act(async () => {
      render(<DashboardTrivia topic="netWorth" heroCycling />);
    });
    await act(async () => vi.advanceTimersByTime(TRIVIA_ROTATE_MS));
    expect(screen.getByTestId('dashboard-trivia')).toHaveTextContent('net one A');
  });

  it('falls back to the other topic when the set on screen has no facts', async () => {
    get.mockResolvedValue(
      list({
        items: [{ topic: 'netWorth', source: 'ai', text: 'net one {a}' }],
        figures: { a: { kind: 'text', value: 'A' } },
      }),
    );
    await show('investments');
    expect(screen.getByTestId('dashboard-trivia')).toHaveTextContent('net one A');
  });

  it('leaves the space empty with nothing to say or a failed request', async () => {
    get.mockResolvedValue(list({}));
    await show();
    expect(screen.queryByTestId('dashboard-trivia')).not.toBeInTheDocument();
  });

  it('stays empty when the request fails', async () => {
    get.mockRejectedValue(new Error('nope'));
    await show();
    expect(screen.queryByTestId('dashboard-trivia')).not.toBeInTheDocument();
  });
});
