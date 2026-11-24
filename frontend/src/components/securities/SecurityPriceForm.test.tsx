import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { SecurityPriceForm } from './SecurityPriceForm';
import { usePreferencesStore } from '@/store/preferencesStore';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

describe('SecurityPriceForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults the price date to the user's day, not the UTC day", () => {
    // 2026-11-24T04:30Z is Nov 23 23:30 in America/New_York (UTC-5).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T04:30:00Z') });
    usePreferencesStore.setState({ preferences: { timezone: 'America/New_York' } as never });
    try {
      render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);
      expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-23');
    } finally {
      act(() => usePreferencesStore.setState({ preferences: null }));
      vi.useRealTimers();
    }
  });

  it('renders form fields', () => {
    render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByLabelText('Date')).toBeInTheDocument();
    expect(screen.getByLabelText('Close Price')).toBeInTheDocument();
    expect(screen.getByLabelText('Open Price (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('High Price (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Low Price (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Volume (optional)')).toBeInTheDocument();
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
      adjustedClose: null,
      volume: 50000000,
      source: 'manual',
      quotedAt: null,
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
      adjustedClose: null,
      volume: 50000000,
      source: 'manual',
      quotedAt: null,
      createdAt: '2025-06-01T00:00:00Z',
    };

    render(<SecurityPriceForm price={price} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByLabelText('Date')).toHaveValue('2025-06-01');
    expect(screen.getByLabelText('Close Price')).toHaveValue('193.500000');
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<SecurityPriceForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
