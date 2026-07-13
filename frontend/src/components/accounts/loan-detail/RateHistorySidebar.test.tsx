import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@/test/render';
import { RateHistorySidebar } from './RateHistorySidebar';
import { RateChangePoint } from '@/lib/loan-history';

// Recharts needs a real layout width; stub it so the table (the part under
// test) renders deterministically in jsdom.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const points: RateChangePoint[] = [
  { date: '2022-05-13', annualRate: 1.75 },
  { date: '2022-08-05', annualRate: 3.25 },
  { date: '2024-11-08', annualRate: 4.5 },
];

describe('RateHistorySidebar', () => {
  it('lists one row per rate change with its date and rate', () => {
    render(<RateHistorySidebar points={points} endDate="2025-03-28" />);

    expect(screen.getByText('Rate History')).toBeInTheDocument();
    expect(screen.getByText('1.75%')).toBeInTheDocument();
    expect(screen.getByText('3.25%')).toBeInTheDocument();
    expect(screen.getByText('4.5%')).toBeInTheDocument();
    // Two columns: Date + Rate.
    expect(screen.getByText('Date')).toBeInTheDocument();
    expect(screen.getByText('Rate')).toBeInTheDocument();
  });

  it('shows the empty state when there are no rate changes', () => {
    render(<RateHistorySidebar points={[]} endDate={null} />);
    expect(screen.getByText(/No rate changes recorded/)).toBeInTheDocument();
  });
});
