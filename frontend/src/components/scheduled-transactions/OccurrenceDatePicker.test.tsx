import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { OccurrenceDatePicker } from './OccurrenceDatePicker';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

describe('OccurrenceDatePicker', () => {
  const scheduledTransaction = {
    id: 's1',
    name: 'Rent',
    nextDueDate: '2025-03-01',
    frequency: 'MONTHLY' as const,
  } as any;

  const onSelect = vi.fn();
  const onClose = vi.fn();

  it('renders dialog title and transaction name', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Select Occurrence Date')).toBeInTheDocument();
    expect(screen.getByText(/Rent/)).toBeInTheDocument();
  });

  it('renders calculated occurrence dates', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    // Should show dates for monthly frequency
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
  });

  it('calls onSelect when a date is clicked', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('2025-03-01'));
    expect(onSelect).toHaveBeenCalledWith('2025-03-01');
  });

  it('marks overridden dates as modified', () => {
    const overrides = [{ originalDate: '2025-03-01', overrideDate: '2025-03-05' }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Modified')).toBeInTheDocument();
  });
});
