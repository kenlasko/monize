import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { PayeeList } from './PayeeList';

vi.mock('@/lib/payees', () => ({
  payeesApi: { delete: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('PayeeList', () => {
  const onEdit = vi.fn();
  const onRefresh = vi.fn();

  it('renders empty state', () => {
    render(<PayeeList payees={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('No payees')).toBeInTheDocument();
  });

  it('renders payees table', () => {
    const payees = [
      { id: 'p1', name: 'Walmart', defaultCategory: { name: 'Food', color: '#ef4444' }, transactionCount: 10 },
      { id: 'p2', name: 'Netflix', defaultCategory: null, transactionCount: 3, notes: 'Streaming' },
    ] as any[];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const payees = [
      { id: 'p1', name: 'Walmart', defaultCategory: null, transactionCount: 0 },
    ] as any[];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Walmart' }));
  });

  it('shows delete button for each payee', () => {
    const payees = [
      { id: 'p1', name: 'Walmart', defaultCategory: null, transactionCount: 0 },
    ] as any[];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });
});
