import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SecurityList } from './SecurityList';

describe('SecurityList', () => {
  const onEdit = vi.fn();
  const onToggleActive = vi.fn();

  it('renders empty state', () => {
    render(<SecurityList securities={[]} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('No securities')).toBeInTheDocument();
  });

  it('renders securities table with data', () => {
    const securities = [
      { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true },
      { id: 's2', symbol: 'XEQT', name: 'iShares ETF', securityType: 'ETF', exchange: 'TSX', currencyCode: 'CAD', isActive: false },
    ] as any[];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('XEQT')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const securities = [
      { id: 's1', symbol: 'AAPL', name: 'Apple', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true },
    ] as any[];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('shows deactivate button for active securities', () => {
    const securities = [
      { id: 's1', symbol: 'AAPL', name: 'Apple', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD', isActive: true },
    ] as any[];

    render(<SecurityList securities={securities} onEdit={onEdit} onToggleActive={onToggleActive} />);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });
});
