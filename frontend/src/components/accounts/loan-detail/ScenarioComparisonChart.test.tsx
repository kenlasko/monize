import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ScenarioComparisonChart, ScenarioOutcome } from './ScenarioComparisonChart';

const outcomes: ScenarioOutcome[] = [
  {
    id: 's1',
    name: 'Aggressive',
    recurringExtra: 1500,
    lumpSumCount: 0,
    interestSaved: 30000,
    payoffDate: '2030-06-15',
  },
  {
    id: 's2',
    name: 'Moderate',
    recurringExtra: 500,
    lumpSumCount: 2,
    interestSaved: 15000,
    payoffDate: '2035-03-15',
  },
];

const baseline = { totalInterest: 50000, payoffDate: '2040-01-15' };

describe('ScenarioComparisonChart', () => {
  it('shows the overpayment, interest saved, and payoff date for every scenario', () => {
    render(
      <ScenarioComparisonChart
        outcomes={outcomes}
        baseline={baseline}
        currencyCode="PLN"
      />,
    );

    expect(screen.getByText('Scenario comparison')).toBeInTheDocument();

    // Per-scenario name + recurring overpayment summary (with lump sums when present)
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
    expect(screen.getByText(/1,500.*extra per payment/)).toBeInTheDocument();
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    expect(screen.getByText(/500.*extra per payment \+ 2 lump sums/)).toBeInTheDocument();

    // Interest saved and payoff date are labelled directly on each row
    expect(screen.getByText(/30,000/)).toBeInTheDocument();
    expect(screen.getByText(/15,000/)).toBeInTheDocument();
    expect(screen.getByText('Jun 2030')).toBeInTheDocument();
    expect(screen.getByText('Mar 2035')).toBeInTheDocument();

    // The no-overpayment baseline renders as a context line, not a bar
    expect(screen.getByText(/Without overpayments/)).toBeInTheDocument();
    expect(screen.getByText(/Jan 2040/)).toBeInTheDocument();
  });

  it('labels a scenario that never pays off within the projection', () => {
    render(
      <ScenarioComparisonChart
        outcomes={[{ ...outcomes[0], payoffDate: null }]}
        baseline={baseline}
        currencyCode="PLN"
      />,
    );

    expect(screen.getByText('Beyond projection')).toBeInTheDocument();
  });
});
