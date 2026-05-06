import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityLookupPicker, type LookupCandidate } from './SecurityLookupPicker';

const candidates: LookupCandidate[] = [
  { symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', securityType: 'EQUITY', currencyCode: 'USD', provider: 'yahoo' },
  { symbol: 'MSFT', name: 'Microsoft', exchange: null, securityType: null, currencyCode: null, provider: 'msn', msnInstrumentId: 'm1' },
  { symbol: 'GOOG', name: 'Google', exchange: 'NASDAQ', securityType: 'EQUITY', currencyCode: 'USD' },
];

describe('SecurityLookupPicker', () => {
  it('renders nothing meaningful when closed', () => {
    const { container } = render(
      <SecurityLookupPicker isOpen={false} query="apple" candidates={candidates} onPick={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container.querySelector('h2')).toBeNull();
  });

  it('renders all candidates with provider badges and dashes for nulls', () => {
    render(
      <SecurityLookupPicker isOpen={true} query="apple" candidates={candidates} onPick={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Multiple matches for/)).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('GOOG')).toBeInTheDocument();
    expect(screen.getByText('Yahoo')).toBeInTheDocument();
    expect(screen.getByText('MSN')).toBeInTheDocument();
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('calls onPick when row is clicked', () => {
    const onPick = vi.fn();
    render(
      <SecurityLookupPicker isOpen={true} query="x" candidates={candidates} onPick={onPick} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Apple'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL' }));
  });

  it('calls onPick when Select button is clicked', () => {
    const onPick = vi.fn();
    render(
      <SecurityLookupPicker isOpen={true} query="x" candidates={candidates} onPick={onPick} onCancel={vi.fn()} />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Select' });
    fireEvent.click(buttons[1]);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'MSFT' }));
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <SecurityLookupPicker isOpen={true} query="x" candidates={candidates} onPick={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
