import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { PortfolioHeroFolio } from './PortfolioHeroFolio';
import { PortfolioHeroPebble } from './PortfolioHeroPebble';
import { PortfolioHeroStandard } from './PortfolioHeroStandard';
import type { PortfolioHeroViewProps } from './portfolio-hero-view';

vi.mock('@/hooks/useCollapsingHeaderTitle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCollapsingHeaderTitle')>()),
  useCollapsingHeaderTitle: () => () => {},
}));

const total = (value: number) => ({ value, missingCurrencies: [], excludedCount: 0 });

const props: PortfolioHeroViewProps = {
  label: 'Portfolio summary',
  currency: 'USD',
  caption: 'Portfolio value (All Accounts)',
  total: total(154523.85),
  collapsed: { title: 'Portfolio value', figure: '$154,523.85' },
  change: { kind: 'known', up: true, text: 'Up $12,345.67 · 1Y' },
  holdings: total(150000.4),
  cash: total(4523.45),
  unknown: <span>withheld</span>,
  metric: { name: 'TWR', label: 'TWR', value: '+8.40 %' },
  chart: <div>the chart</div>,
};

describe.each([
  ['Folio', PortfolioHeroFolio],
  ['Pebble', PortfolioHeroPebble],
])('PortfolioHero%s', (_name, Variant) => {
  it('lays out the same figures as the net worth set: the value, its change, and three labelled figures', () => {
    render(<Variant {...props} />);
    expect(screen.getByRole('region', { name: 'Portfolio summary' })).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent('$154,523.85');
    expect(screen.getByTestId('dashboard-hero-pill')).toHaveTextContent('Up $12,345.67 · 1Y');
    for (const [label, figure] of [
      ['Holdings', '150,000.4'],
      ['Cash', '4,523.45'],
      ['TWR', '+8.40 %'],
    ]) {
      const term = screen.getByText(label);
      expect(term.tagName).toBe('DT');
      expect(term.nextElementSibling?.textContent).toContain(figure);
    }
    expect(screen.getByTestId('dashboard-hero-metric')).toHaveTextContent('+8.40 %');
    expect(screen.getByTestId('dashboard-hero-chart')).toHaveTextContent('the chart');
  });

  it('says a change it cannot measure is unknown, and holds the place of one still on its way', () => {
    const { rerender } = render(
      <Variant {...props} change={{ kind: 'unknown', text: 'Couldn\'t load the change' }} />,
    );
    expect(screen.getByTestId('dashboard-hero-pill')).toHaveTextContent('Couldn\'t load the change');
    rerender(<Variant {...props} change={{ kind: 'pending' }} />);
    expect(screen.getByTestId('dashboard-hero-figure-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-hero-pill')).not.toBeInTheDocument();
    rerender(<Variant {...props} change={null} />);
    expect(screen.queryByTestId('dashboard-hero-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-hero-figure-skeleton')).not.toBeInTheDocument();
  });
});

describe.each([
  ['Folio', PortfolioHeroFolio],
  ['Pebble', PortfolioHeroPebble],
  ['Standard', PortfolioHeroStandard],
])('PortfolioHero%s with one withheld figure', (_name, Variant) => {
  it('draws the withheld marker for the cash and keeps every other figure', () => {
    render(<Variant {...props} cash={null} />);
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent('$154,523.85');
    expect(screen.getByText('withheld')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-metric')).toHaveTextContent('+8.40 %');
    expect(screen.getByTestId('dashboard-hero-chart')).toHaveTextContent('the chart');
  });
});

describe('PortfolioHeroFolio and PortfolioHeroPebble set the value as the net worth set does', () => {
  it('Folio uses the serif display size, Pebble the grotesque one', () => {
    const { unmount } = render(<PortfolioHeroFolio {...props} />);
    expect(screen.getByTestId('dashboard-hero-headline').className).toContain('lg:text-[84px]');
    unmount();
    render(<PortfolioHeroPebble {...props} />);
    expect(screen.getByTestId('dashboard-hero-headline').className).toContain('xl:text-[92px]');
  });
});

describe('PortfolioHeroStandard', () => {
  it('keeps the sentence form: figures with their words after them', () => {
    render(<PortfolioHeroStandard {...props} />);
    expect(screen.getByText(/holdings/)).toHaveTextContent('150,000.4');
    expect(screen.getByTestId('dashboard-hero-metric')).toHaveTextContent(/\+8\.40 %\s?TWR/);
  });
});
