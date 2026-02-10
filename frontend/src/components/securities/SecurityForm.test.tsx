import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SecurityForm } from './SecurityForm';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    lookupSecurity: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('SecurityForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it('renders create form fields', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Exchange')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('shows Create Security button for new form', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Create Security')).toBeInTheDocument();
  });

  it('shows Update Security button when editing', () => {
    const security = { id: 's1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', exchange: 'NASDAQ', currencyCode: 'USD' } as any;
    render(<SecurityForm security={security} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Security')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<SecurityForm onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
