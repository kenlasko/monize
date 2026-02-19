import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetHealthGauge } from './BudgetHealthGauge';

describe('BudgetHealthGauge', () => {
  it('renders the heading', () => {
    render(<BudgetHealthGauge score={85} />);

    expect(screen.getByText('Health Score')).toBeInTheDocument();
  });

  it('displays the score value', () => {
    render(<BudgetHealthGauge score={85} />);

    expect(screen.getByTestId('score-value')).toHaveTextContent('85');
  });

  it('shows Excellent label for score >= 90', () => {
    render(<BudgetHealthGauge score={95} />);

    expect(screen.getByTestId('score-label')).toHaveTextContent('Excellent');
  });

  it('shows Good label for score 70-89', () => {
    render(<BudgetHealthGauge score={85} />);

    expect(screen.getByTestId('score-label')).toHaveTextContent('Good');
  });

  it('shows Needs Attention label for score 50-69', () => {
    render(<BudgetHealthGauge score={55} />);

    expect(screen.getByTestId('score-label')).toHaveTextContent('Needs Attention');
  });

  it('shows Off Track label for score < 50', () => {
    render(<BudgetHealthGauge score={30} />);

    expect(screen.getByTestId('score-label')).toHaveTextContent('Off Track');
  });

  it('clamps score to 0-100 range', () => {
    render(<BudgetHealthGauge score={150} />);

    expect(screen.getByTestId('score-value')).toHaveTextContent('100');
  });

  it('clamps negative score to 0', () => {
    render(<BudgetHealthGauge score={-10} />);

    expect(screen.getByTestId('score-value')).toHaveTextContent('0');
  });

  it('rounds fractional scores', () => {
    render(<BudgetHealthGauge score={72.6} />);

    expect(screen.getByTestId('score-value')).toHaveTextContent('73');
  });

  it('renders SVG ring', () => {
    render(<BudgetHealthGauge score={50} />);

    const ring = screen.getByTestId('score-ring');
    expect(ring).toBeInTheDocument();
  });
});
