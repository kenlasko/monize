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

const baseline = { payoffDate: '2040-01-15' };

describe('ScenarioComparisonChart', () => {
  it('draws an arc per scenario labelled with all three figures', () => {
    render(
      <ScenarioComparisonChart
        outcomes={outcomes}
        baseline={baseline}
        currencyCode="PLN"
      />,
    );

    expect(screen.getByText('Scenario comparison')).toBeInTheDocument();
    expect(screen.getAllByTestId('scenario-arc')).toHaveLength(2);

    // Apex labels: scenario name + the extra paid per installment (with lump
    // sums when present); the legend restates them, hence getAllByText.
    expect(screen.getAllByText('Aggressive').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+.*1,500.*\/ payment/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\+.*500.*\/ payment \+ 2 lump sums/).length).toBeGreaterThan(0);

    // Interest saved at the apex and the payoff date at the arc's foot
    expect(screen.getAllByText(/30,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/15,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Jun 2030').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mar 2035').length).toBeGreaterThan(0);

    // The no-overpayment baseline is a marker at the original payoff date
    expect(screen.getByText(/No overpayments/)).toHaveTextContent('Jan 2040');
  });

  it('labels a scenario that never pays off within the projection', () => {
    render(
      <ScenarioComparisonChart
        outcomes={[{ ...outcomes[0], payoffDate: null }]}
        baseline={baseline}
        currencyCode="PLN"
      />,
    );

    expect(screen.getAllByText('Beyond projection').length).toBeGreaterThan(0);
  });
});
