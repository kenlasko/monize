import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { TriviaWidget, TRIVIA_ROTATE_MS } from './TriviaWidget';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

const state: { trivia: DashboardTriviaResponse | null; asked: boolean[]; enabled: boolean | undefined } = {
  trivia: null,
  asked: [],
  enabled: undefined,
};
vi.mock('./useDashboardTrivia', () => ({
  useDashboardTrivia: (enabled: boolean) => {
    state.asked.push(enabled);
    return enabled ? state.trivia : null;
  },
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({ preferences: { aiTriviaEnabled: state.enabled } }),
}));

const list = (over: Partial<DashboardTriviaResponse>): DashboardTriviaResponse => ({
  items: [],
  figures: {},
  generatedAt: '2026-11-09T06:30:00.000Z',
  ...over,
});

const three = () =>
  list({
    items: [
      { topic: 'netWorth', source: 'ai', text: 'one {a}' },
      { topic: 'investments', source: 'ai', text: 'two {a}' },
      { topic: 'netWorth', source: 'ai', text: 'three {a}' },
    ],
    figures: { a: { kind: 'text', value: 'A' } },
  });

const sentence = () => screen.getByTestId('trivia-sentence');

describe('TriviaWidget', () => {
  beforeEach(() => {
    state.trivia = null;
    state.asked = [];
    state.enabled = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a calculated fact from the catalog, its figures picked out and formatted', () => {
    state.trivia = list({
      items: [{ topic: 'netWorth', source: 'calculated', factId: 'netWorthHighPoint' }],
      figures: {
        peakAmount: { kind: 'money', value: 3913005.98, currency: 'CAD' },
        peakMonth: { kind: 'month', value: '2026-09' },
        peakBelow: { kind: 'money', value: 64910, currency: 'CAD' },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent('Your high point was');
    expect(screen.getByText(/3,913,005\.98/)).toHaveClass('font-semibold');
    expect(screen.getByText('September 2026')).toHaveClass('font-semibold');
    expect(screen.getByText('Net worth')).toBeInTheDocument();
    expect(screen.queryByText('Written by AI from your figures')).not.toBeInTheDocument();
  });

  it('fills a model sentence from the figures and says the AI wrote it', () => {
    state.trivia = list({
      items: [{ topic: 'investments', source: 'ai', text: 'You hold {name}, up {pct} at {rate}, {multiple} times.' }],
      figures: {
        name: { kind: 'text', value: 'XGRO' },
        pct: { kind: 'percent', value: 12.5 },
        rate: { kind: 'rate', value: 1.4066 },
        multiple: { kind: 'multiple', value: 2.03 },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent('You hold XGRO, up 12.50% at 1.4066, 2.03 times.');
    expect(screen.getByText('Investments')).toBeInTheDocument();
    expect(screen.getByText('Written by AI from your figures')).toBeInTheDocument();
  });

  it('never renders a model sentence as markup', () => {
    state.trivia = list({
      items: [{ topic: 'netWorth', source: 'ai', text: '<img src=x onerror=alert(1)> {a}' }],
      figures: { a: { kind: 'text', value: 'A' } },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence().querySelector('img')).toBeNull();
    expect(sentence()).toHaveTextContent('<img src=x onerror=alert(1)> A');
  });

  it('moves on by itself, and holds while the reader points at it', async () => {
    state.trivia = three();
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent('one A');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(TRIVIA_ROTATE_MS));
    expect(sentence()).toHaveTextContent('two A');
    fireEvent.mouseEnter(screen.getByTestId('trivia-card').parentElement!);
    await act(async () => vi.advanceTimersByTime(TRIVIA_ROTATE_MS * 3));
    expect(sentence()).toHaveTextContent('two A');
  });

  it('steps both ways on its arrows, wrapping round the list', async () => {
    state.trivia = three();
    render(<TriviaWidget isLoading={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous fact' }));
    });
    expect(sentence()).toHaveTextContent('three A');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next fact' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next fact' }));
    });
    expect(sentence()).toHaveTextContent('two A');
  });

  it('keeps one card size whatever the sentence, so the widgets around it never shift', () => {
    state.trivia = list({
      items: [
        { topic: 'netWorth', source: 'ai', text: 'short {a}' },
        { topic: 'investments', source: 'calculated', factId: 'investmentsCagr' },
      ],
      figures: { a: { kind: 'text', value: 'A' }, cagrPercent: { kind: 'percent', value: 7 } },
    });
    render(<TriviaWidget isLoading={false} />);
    const sentence = screen.getByTestId('trivia-sentence');
    // The sentence takes no height of its own: it fills a fixed box and scrolls.
    expect(sentence).toHaveClass('h-0', 'flex-1', 'overflow-y-auto');
    const card = sentence.closest('figure')!.parentElement!;
    const before = card.className;
    const caption = card.querySelector('figcaption')!;
    fireEvent.click(screen.getByRole('button', { name: 'Next fact' }));
    expect(card.className).toBe(before);
    // The AI line keeps its place on a calculated fact too.
    expect(card.querySelector('figcaption')).toHaveClass('h-4');
    expect(caption).toBeInTheDocument();
  });

  it('offers no arrows for a single fact', () => {
    state.trivia = list({
      items: [{ topic: 'netWorth', source: 'ai', text: 'only {a}' }],
      figures: { a: { kind: 'text', value: 'A' } },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(screen.queryByRole('button', { name: 'Next fact' })).not.toBeInTheDocument();
  });

  it('says when there is nothing to tell yet', () => {
    state.trivia = list({});
    render(<TriviaWidget isLoading={false} />);
    expect(screen.getByText(/Facts appear here once there is enough history/)).toBeInTheDocument();
  });

  it('points to AI Settings when switched off, and asks for nothing', () => {
    state.enabled = false;
    render(<TriviaWidget isLoading={false} />);
    expect(screen.getByRole('link', { name: 'AI Settings' })).toHaveAttribute('href', '/settings/ai');
    expect(state.asked).not.toContain(true);
  });

  it('waits for the dashboard before asking', () => {
    state.trivia = three();
    render(<TriviaWidget isLoading />);
    expect(state.asked).not.toContain(true);
    expect(screen.queryByTestId('trivia-sentence')).not.toBeInTheDocument();
  });
});
