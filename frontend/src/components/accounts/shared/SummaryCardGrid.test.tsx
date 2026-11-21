import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import {
  SummaryCardGrid,
  DEFAULT_SUMMARY_GRID,
  SummaryCardItem,
  summaryGridClass,
} from './SummaryCardGrid';

describe('SummaryCardGrid', () => {
  const cards: SummaryCardItem[] = [
    { label: 'Current Balance', value: '$1,200.00', valueClass: 'text-red-600' },
    { label: 'Available Credit', value: '$3,800.00', note: '76% remaining' },
  ];

  describe('summaryGridClass', () => {
    // A banking account grows from five cards to seven as it gains an interest
    // rate and then earns interest; every one of those has to sit on one row.
    it.each([
      [4, 'lg:grid-cols-4'],
      [5, 'lg:grid-cols-5'],
      [6, 'lg:grid-cols-6'],
      [7, 'lg:grid-cols-7'],
    ])('gives %i cards their own column each', (count, expected) => {
      expect(summaryGridClass(count)).toContain(expected);
    });

    it('still wraps on smaller screens, where one row would not fit', () => {
      expect(summaryGridClass(7)).toContain('grid-cols-2');
      expect(summaryGridClass(7)).toContain('md:grid-cols-3');
    });

    it('stops widening past the point the cards become unreadable', () => {
      expect(summaryGridClass(20)).toContain('lg:grid-cols-8');
    });

    it('never emits an interpolated class Tailwind cannot see', () => {
      // Guards the reason the column classes are written out longhand.
      expect(summaryGridClass(0)).toContain('lg:grid-cols-1');
      expect(summaryGridClass(3)).not.toContain('undefined');
    });
  });

  it('renders each card label and value', () => {
    render(<SummaryCardGrid cards={cards} />);

    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('$1,200.00')).toBeInTheDocument();
    expect(screen.getByText('Available Credit')).toBeInTheDocument();
    expect(screen.getByText('$3,800.00')).toBeInTheDocument();
  });

  it('renders the optional note only when provided', () => {
    render(<SummaryCardGrid cards={cards} />);

    expect(screen.getByText('76% remaining')).toBeInTheDocument();
    // The first card has no note.
    const balanceCard = screen.getByText('Current Balance').closest('article');
    expect(balanceCard?.querySelector('.text-xs')).toBeNull();
  });

  it('applies the value colour class', () => {
    render(<SummaryCardGrid cards={cards} />);
    expect(screen.getByText('$1,200.00').className).toContain('text-red-600');
  });

  it('uses the default grid layout when no className is given', () => {
    const { container } = render(<SummaryCardGrid cards={cards} />);
    expect(container.firstElementChild?.className).toBe(DEFAULT_SUMMARY_GRID);
  });

  it('accepts a custom grid className', () => {
    const { container } = render(
      <SummaryCardGrid cards={cards} className="grid grid-cols-4 gap-2" />,
    );
    expect(container.firstElementChild?.className).toBe('grid grid-cols-4 gap-2');
  });

  it('exposes an accessible label per card', () => {
    render(
      <SummaryCardGrid
        cards={[{ label: 'Utilization', value: '24%', ariaLabel: 'Credit utilization 24 percent' }]}
      />,
    );
    expect(screen.getByLabelText('Credit utilization 24 percent')).toBeInTheDocument();
  });

  it('falls back to the label as the accessible name', () => {
    render(<SummaryCardGrid cards={[{ label: 'Interest Rate', value: '19.99%' }]} />);
    expect(screen.getByLabelText('Interest Rate')).toBeInTheDocument();
  });

  it('renders a clickable card as a button when onClick is set', () => {
    const onClick = vi.fn();
    render(<SummaryCardGrid cards={[{ label: 'Money In', value: '$100', onClick }]} />);
    const button = screen.getByRole('button', { name: 'Money In' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('marks each card as a stat tile, and the lead card as the lead', () => {
    render(
      <SummaryCardGrid
        cards={[
          { label: 'Balance', value: '$1,200.00', lead: true },
          { label: 'Limit', value: '$5,000.00' },
        ]}
      />,
    );
    const lead = screen.getByRole('article', { name: 'Balance' });
    expect(lead).toHaveClass('ui-stat', 'ui-stat-lead');
    expect(screen.getByRole('article', { name: 'Limit' })).not.toHaveClass('ui-stat-lead');
    expect(screen.getByText('$1,200.00')).toHaveClass('ui-stat-value');
  });
});
