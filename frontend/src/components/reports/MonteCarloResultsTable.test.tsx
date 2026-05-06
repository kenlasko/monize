import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ResultsTable, SummaryStat } from './MonteCarloResultsTable';

const fmt = (v: number) => `$${v.toFixed(0)}`;

describe('SummaryStat', () => {
  it('renders label and value', () => {
    render(<SummaryStat label="Median" value="$1,000" />);
    expect(screen.getByText('Median')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <SummaryStat label="X" value="Y" className="custom-class" />,
    );
    expect(container.querySelector('.custom-class')).toBeTruthy();
  });
});

describe('ResultsTable', () => {
  it('renders rows with no events as em dash', () => {
    render(
      <ResultsTable
        rows={[
          { year: '2025', p10: 100, p25: 200, p50: 300, p75: 400, p90: 500, events: [] },
        ]}
        formatCurrency={fmt}
      />,
    );
    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('renders rows with one-time events and recurring start/end events for income and expense', () => {
    render(
      <ResultsTable
        rows={[
          {
            year: '2030',
            p10: 0,
            p25: 0,
            p50: 0,
            p75: 0,
            p90: 0,
            events: [
              { role: 'start', income: true, name: 'Bonus', amount: 1000, flowType: 'ONE_TIME', startYear: 2030, inflationAdjust: false },
              { role: 'start', income: false, name: 'Mortgage', amount: 500, flowType: 'RECURRING', startYear: 2030, endYear: 2050, inflationAdjust: true },
              { role: 'end', income: true, name: 'Salary', amount: 2000, flowType: 'RECURRING', startYear: 2025, endYear: 2030, inflationAdjust: false },
            ],
          },
        ]}
        formatCurrency={fmt}
      />,
    );
    expect(screen.getByText('Bonus')).toBeInTheDocument();
    expect(screen.getByText('Starts: Mortgage')).toBeInTheDocument();
    expect(screen.getByText('Ends: Salary')).toBeInTheDocument();
  });
});
