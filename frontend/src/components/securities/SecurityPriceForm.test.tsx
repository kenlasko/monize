import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SecurityPriceForm } from './SecurityPriceForm';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser' }),
}));

describe('SecurityPriceForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form fields', () => {
    render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByLabelText('Date')).toBeInTheDocument();
    expect(screen.getByLabelText('Close Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Open Price')).toBeInTheDocument();
    expect(screen.getByLabelText('High Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Low Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Volume')).toBeInTheDocument();
  });

  it('shows Add Price button for new entry', () => {
    render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Add Price')).toBeInTheDocument();
  });

  it('shows Update Price button when editing', () => {
    const price = {
      id: 1,
      securityId: 'sec-1',
      priceDate: '2025-06-01',
      openPrice: 190,
      highPrice: 195,
      lowPrice: 189,
      closePrice: 193.5,
      volume: 50000000,
      source: 'manual',
      createdAt: '2025-06-01T00:00:00Z',
    };

    render(<SecurityPriceForm price={price} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Price')).toBeInTheDocument();
  });

  it('pre-fills values when editing', () => {
    const price = {
      id: 1,
      securityId: 'sec-1',
      priceDate: '2025-06-01',
      openPrice: 190,
      highPrice: 195,
      lowPrice: 189,
      closePrice: 193.5,
      volume: 50000000,
      source: 'manual',
      createdAt: '2025-06-01T00:00:00Z',
    };

    render(<SecurityPriceForm price={price} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByLabelText('Date')).toHaveValue('2025-06-01');
    expect(screen.getByLabelText('Close Price')).toHaveValue(193.5);
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
