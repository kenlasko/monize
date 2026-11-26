import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderInLocale, screen } from '@/test/render';
import dashboardMessages from '@/i18n/messages/en/dashboard.json';
import { TriviaWidget, TRIVIA_ROTATE_MS } from './TriviaWidget';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

const state: {
  trivia: DashboardTriviaResponse | null;
  asked: boolean[];
  enabled: boolean | undefined;
  today: string;
} = {
  trivia: null,
  today: '',
  asked: [],
  enabled: undefined,
};
vi.mock('./useDashboardTrivia', () => ({
  useDashboardTrivia: (enabled: boolean) => {
    state.asked.push(enabled);
    return enabled ? state.trivia : null;
  },
}));
// A day on which every fact these tests read picks its first wording (see trivia-variant.ts).
const FIRST_WORDING_DAY = '2026-01-26';
vi.mock('@/hooks/useFinancialToday', () => ({ useFinancialToday: () => state.today }));
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
    state.today = FIRST_WORDING_DAY;
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

  it('draws the newer topics in their own colour and formats a count as a whole number', () => {
    state.trivia = list({
      items: [{ topic: 'warranties', source: 'calculated', factId: 'warrantiesCovered' }],
      figures: { warrantyCount: { kind: 'count', value: 3 } },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(screen.getByText('Warranties')).toHaveClass('text-cyan-700');
    expect(screen.getByTestId('trivia-sentence')).toHaveTextContent(
      'Warranties you track that are still in cover: 3.',
    );
  });

  it('every topic the server sends has a label and a look', () => {
    for (const topic of ['spending', 'income', 'activity'] as const) {
      state.trivia = list({
        items: [{ topic, source: 'ai', text: 'x {a}' }],
        figures: { a: { kind: 'count', value: 1200 } },
      });
      const { unmount } = render(<TriviaWidget isLoading={false} />);
      expect(screen.getByTestId('trivia-card').className).toContain('from-');
      unmount();
    }
  });

  it('skips a calculated fact its catalog lacks and counts only what it shows', () => {
    state.trivia = list({
      items: [
        { topic: 'netWorth', source: 'calculated', factId: 'aFactFromANewerServer' },
        { topic: 'netWorth', source: 'ai', text: 'one {a}' },
        { topic: 'investments', source: 'ai', text: 'two {a}' },
      ],
      figures: { a: { kind: 'text', value: 'A' } },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(sentence()).not.toHaveTextContent('aFactFromANewerServer');
  });

  it('writes a day figure with its weekday', () => {
    state.trivia = list({
      items: [{ topic: 'spending', source: 'ai', text: 'On {d} you spent {n}.' }],
      figures: { d: { kind: 'day', value: '2026-11-18' }, n: { kind: 'count', value: 2 } },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent('On Wednesday, November 18 you spent 2.');
  });

  it('writes a date figure in full and a years figure with its unit', () => {
    state.trivia = list({
      items: [{ topic: 'activity', source: 'calculated', factId: 'activityAnniversary' }],
      figures: {
        anniversaryYears: { kind: 'years', value: 3 },
        anniversaryFirstDate: { kind: 'date', value: '2023-11-17' },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent(
      'This week marks 3 years since your first transaction in Monize, on November 17, 2023.',
    );
  });

  it.each([FIRST_WORDING_DAY, '2026-11-03', '2026-11-04'])('describes signed budget spending as a net amount on %s', (date) => {
    state.today = date;
    state.trivia = list({
      items: [{ topic: 'spending', source: 'calculated', factId: 'spendingBudgetPace' }],
      figures: {
        budgetName: { kind: 'text', value: 'Household' },
        budgetSpent: { kind: 'money', value: -50, currency: 'USD' },
        budgetTotal: { kind: 'money', value: 100, currency: 'USD' },
        budgetUsedPercent: { kind: 'percent', value: -50 },
        budgetMonthPercent: { kind: 'percent', value: 60 },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent(/Net spending: .*50.*-50/);
    expect(sentence()).toHaveTextContent(/Budget: .*100/);
  });

  it('words a windowed fact by its window', () => {
    state.trivia = list({
      items: [
        {
          topic: 'spending',
          source: 'calculated',
          factId: 'spendingTopCategoryWindow',
          params: { window: 'd90' },
        },
      ],
      figures: {
        topCategoryName: { kind: 'text', value: 'Groceries' },
        topCategoryAmount: { kind: 'money', value: 600, currency: 'CAD' },
        topCategoryPercent: { kind: 'percent', value: 33.3 },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent(
      'Over the last 90 days, Groceries took the most of your spending:',
    );
  });

  it('words a ranked fact with its rank and window', () => {
    state.trivia = list({
      items: [
        {
          topic: 'income',
          source: 'calculated',
          factId: 'incomeRankedSource',
          params: { window: 'all' },
        },
      ],
      figures: {
        rankedSourceName: { kind: 'text', value: 'Interest' },
        rankedSourceRank: { kind: 'count', value: 2 },
        rankedSourcePercent: { kind: 'percent', value: 15 },
      },
    });
    render(<TriviaWidget isLoading={false} />);
    expect(sentence()).toHaveTextContent(
      'Since your records began, Interest was number 2 among your sources of income, bringing in',
    );
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

  describe('wording variants', () => {
    const highPoint = () => {
      state.trivia = list({
        items: [{ topic: 'netWorth', source: 'calculated', factId: 'netWorthHighPoint' }],
        figures: {
          peakAmount: { kind: 'money', value: 3913005.98, currency: 'CAD' },
          peakMonth: { kind: 'month', value: '2026-09' },
          peakBelow: { kind: 'money', value: 64910, currency: 'CAD' },
        },
      });
    };

    it('words a fact differently on different days', () => {
      highPoint();
      state.today = '2026-11-01';
      const first = render(<TriviaWidget isLoading={false} />);
      expect(sentence()).toHaveTextContent('Your high point was');
      first.unmount();

      state.today = '2026-11-03';
      const second = render(<TriviaWidget isLoading={false} />);
      expect(sentence()).toHaveTextContent('Net worth peaked at');
      second.unmount();

      state.today = '2026-11-02';
      render(<TriviaWidget isLoading={false} />);
      expect(sentence()).toHaveTextContent('under your high point of');
      // Every variant still picks out the same figures.
      expect(screen.getByText('September 2026')).toHaveClass('font-semibold');
    });

    it('keeps one wording for the whole day, across re-renders and steps', () => {
      highPoint();
      state.today = '2026-11-03';
      const { rerender } = render(<TriviaWidget isLoading={false} />);
      const before = sentence().textContent;
      rerender(<TriviaWidget isLoading={false} />);
      expect(sentence().textContent).toBe(before);
      expect(before).toContain('Net worth peaked at');
    });

    it('falls back to the first wording where the locale has no variants, without an error', () => {
      highPoint();
      state.today = '2026-11-03'; // picks variant b where there is one
      const { variants: _variants, ...trivia } = dashboardMessages.trivia;
      void _variants;
      // An intl error (a missing key) fails the test through renderInLocale's onError.
      renderInLocale(<TriviaWidget isLoading={false} />, {
        locale: 'en',
        messages: { dashboard: { ...dashboardMessages, trivia } },
      });
      expect(sentence()).toHaveTextContent('Your high point was');
      expect(sentence().textContent).not.toContain('trivia.');
    });
  });
});
