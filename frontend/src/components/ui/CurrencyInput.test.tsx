import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CurrencyInput } from './CurrencyInput';

describe('CurrencyInput', () => {
  it('renders with label', () => {
    render(<CurrencyInput label="Amount" value={100} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
  });

  it('shows formatted value', () => {
    render(<CurrencyInput label="Amount" value={1234.56} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('1,234.56');
  });

  it('shows error message', () => {
    render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} error="Required" />);
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('renders prefix', () => {
    render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} prefix="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('calls onChange on input', () => {
    const onChange = vi.fn();
    render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '50' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('has displayName', () => {
    expect(CurrencyInput.displayName).toBe('CurrencyInput');
  });

  it('shows empty string for undefined value', () => {
    render(<CurrencyInput label="Amount" value={undefined} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('');
  });
});
