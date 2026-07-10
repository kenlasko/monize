import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { InterestAndFeesPanel } from './InterestAndFeesPanel';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ formatCurrency: (a: number) => `$${a.toFixed(2)}` }),
}));

describe('InterestAndFeesPanel', () => {
  it('shows the YTD amount and charge count', () => {
    render(
      <InterestAndFeesPanel interest={{ amount: 45.5, count: 3 }} currencyCode="CAD" isLoading={false} />,
    );
    expect(screen.getByText('$45.50')).toBeInTheDocument();
    expect(screen.getByText('3 charges')).toBeInTheDocument();
  });

  it('shows an empty state when nothing was charged', () => {
    render(<InterestAndFeesPanel interest={{ amount: 0, count: 0 }} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('No interest or fees charged this year')).toBeInTheDocument();
  });

  it('shows an empty state when the data failed to load', () => {
    render(<InterestAndFeesPanel interest={null} currencyCode="CAD" isLoading={false} />);
    expect(screen.getByText('No interest or fees charged this year')).toBeInTheDocument();
  });
});
