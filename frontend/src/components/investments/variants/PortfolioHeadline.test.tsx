import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import {
  PortfolioHeadlineClassic,
  PortfolioHeadlineModern,
  PortfolioHeadlineStandard,
  type PortfolioHeadlineViewProps,
} from './PortfolioHeadline';

const props: PortfolioHeadlineViewProps = {
  label: 'Total Portfolio Value',
  amount: 160433.56,
  foreignCurrency: null,
  valueText: '$160,433.56',
  approx: null,
  gain: { label: 'Gain/Loss', direction: 'up', text: '+$15,528.02 · +10.7%' },
};

describe('PortfolioHeadline', () => {
  it('Standard prints the plain string', () => {
    render(<PortfolioHeadlineStandard {...props} />);
    expect(screen.getByText('Total Portfolio Value')).toBeInTheDocument();
    expect(screen.getByText('$160,433.56')).toBeInTheDocument();
  });

  it('Classic sets the total as a statement figure with a label', () => {
    render(<PortfolioHeadlineClassic {...props} />);
    expect(screen.getByText('Total Portfolio Value')).toHaveClass('ui-figure-label');
    expect(screen.getByTestId('portfolio-headline')).toHaveTextContent('$160,433.56');
  });

  it('Modern sets the total on the ink block with the gain as a pill', () => {
    render(<PortfolioHeadlineModern {...props} />);
    expect(screen.getByTestId('portfolio-headline')).toHaveClass('ui-invert', 'ui-ink-block');
    expect(screen.getByTestId('portfolio-headline')).toHaveTextContent('$160,433.56');
    expect(screen.getByTestId('portfolio-headline-pill')).toHaveTextContent('+$15,528.02');
    expect(screen.getByText('Gain/Loss')).toBeInTheDocument();
  });

  it('names a foreign currency beside the figure and keeps the approximation', () => {
    render(
      <PortfolioHeadlineModern {...props} foreignCurrency="EUR" approx={'≈ $1.00 USD'} />,
    );
    expect(screen.getByText('EUR')).toBeInTheDocument();
    expect(screen.getByText('≈ $1.00 USD')).toBeInTheDocument();
  });
});
