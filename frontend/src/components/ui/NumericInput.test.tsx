import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumericInput } from './NumericInput';

describe('NumericInput', () => {
  it('renders with label', () => {
    render(<NumericInput label="Quantity" value={10} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
  });

  it('shows formatted value', () => {
    render(<NumericInput label="Rate" value={3.14} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Rate')).toHaveValue('3.14');
  });

  it('shows empty for undefined value', () => {
    render(<NumericInput label="Value" value={undefined} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Value')).toHaveValue('');
  });

  it('shows error message', () => {
    render(<NumericInput label="Qty" value={0} onChange={vi.fn()} error="Invalid" />);
    expect(screen.getByText('Invalid')).toBeInTheDocument();
  });

  it('renders prefix and suffix', () => {
    render(<NumericInput label="Rate" value={5} onChange={vi.fn()} prefix="$" suffix="%" />);
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('calls onChange on input', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '42' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('has displayName', () => {
    expect(NumericInput.displayName).toBe('NumericInput');
  });
});
