import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SummaryCardGrid, DEFAULT_SUMMARY_GRID, SummaryCardItem } from './SummaryCardGrid';

describe('SummaryCardGrid', () => {
  const cards: SummaryCardItem[] = [
    { label: 'Current Balance', value: '$1,200.00', valueClass: 'text-red-600' },
    { label: 'Available Credit', value: '$3,800.00', note: '76% remaining' },
  ];

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
});
