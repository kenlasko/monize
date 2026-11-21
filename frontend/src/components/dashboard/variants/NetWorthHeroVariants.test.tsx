import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { NetWorthHeroClassic } from './NetWorthHeroClassic';
import { NetWorthHeroModern } from './NetWorthHeroModern';
import type { NetWorthHeroViewProps } from './net-worth-hero-view';

vi.mock('@/hooks/useCollapsingHeaderTitle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCollapsingHeaderTitle')>()),
  useCollapsingHeaderTitle: () => () => {},
}));

const total = (value: number) => ({ value, missingCurrencies: [], excludedCount: 0 });

const props: NetWorthHeroViewProps = {
  label: 'Net worth summary',
  currency: 'USD',
  netWorth: total(453227.01),
  assets: total(858421.6),
  liabilities: total(405194.59),
  invested: { value: 66684.4, total: total(66684.4) },
  investedLoading: false,
  collapsed: { title: 'Net worth', figure: '$453,227.01' },
  change: { known: true, up: false, text: 'Down $25,845.97 this month' },
  points: [
    { key: '2025-11', value: 763900 },
    { key: '2025-12', value: 378890 },
    { key: '2026-01', value: null },
    { key: '2026-11', value: 453230 },
  ],
  formatTick: (k) => k,
  formatTooltipKey: (k) => k,
  formatNarrowMonth: (k) => k.slice(5),
};

describe.each([
  ['Classic', NetWorthHeroClassic],
  ['Modern', NetWorthHeroModern],
])('NetWorthHero%s', (_name, Variant) => {
  it('lays out the same figures: net worth, the change, and the three labelled totals', () => {
    render(<Variant {...props} />);
    expect(screen.getByRole('region', { name: 'Net worth summary' })).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent('$453,227.01');
    expect(screen.getByTestId('dashboard-hero-pill')).toHaveTextContent('Down $25,845.97 this month');
    for (const [label, figure] of [
      ['Assets', '858,421.6'],
      ['Liabilities', '405,194.59'],
      ['Invested', '66,684.4'],
    ]) {
      const term = screen.getByText(label);
      expect(term.tagName).toBe('DT');
      expect(term.nextElementSibling?.textContent).toContain(figure);
    }
  });

  it('holds the invested figure\'s place while it loads, and leaves it out when there is none', () => {
    const { rerender } = render(<Variant {...props} invested={null} investedLoading />);
    expect(screen.getByText('Invested')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-figure-skeleton')).toBeInTheDocument();
    rerender(<Variant {...props} invested={null} investedLoading={false} />);
    expect(screen.queryByText('Invested')).not.toBeInTheDocument();
  });

  it('says a change it cannot measure is unknown rather than drawing one', () => {
    render(<Variant {...props} change={{ known: false }} />);
    expect(screen.getByTestId('dashboard-hero-pill')).not.toHaveTextContent('Down');
  });
});

describe('NetWorthHeroModern', () => {
  it('names the highest, lowest and latest months of its bars, a gap drawing no bar', () => {
    const { container } = render(<NetWorthHeroModern {...props} />);
    const chart = screen.getByRole('img');
    expect(chart).toHaveAccessibleName(/at its highest.*at its lowest.*now/);
    expect(container.querySelectorAll('svg[role="img"] rect')).toHaveLength(3);
  });
});
