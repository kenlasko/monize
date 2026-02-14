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

  it('strips commas on focus', () => {
    render(<CurrencyInput label="Amount" value={1234.56} onChange={vi.fn()} />);
    const input = screen.getByLabelText('Amount');
    // Before focus, should show comma-formatted
    expect(input).toHaveValue('1,234.56');
    // Focus strips commas
    fireEvent.focus(input);
    expect(input).toHaveValue('1234.56');
  });

  it('clears zero value on focus', () => {
    render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
    const input = screen.getByLabelText('Amount');
    // Before focus, shows "0.00"
    expect(input).toHaveValue('0.00');
    // Focus clears zero
    fireEvent.focus(input);
    expect(input).toHaveValue('');
  });

  it('calls onFocus callback', () => {
    const onFocus = vi.fn();
    render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} onFocus={onFocus} />);
    fireEvent.focus(screen.getByLabelText('Amount'));
    expect(onFocus).toHaveBeenCalled();
  });

  it('calls onBlur callback', () => {
    const onBlur = vi.fn();
    render(<CurrencyInput label="Amount" value={100} onChange={vi.fn()} onBlur={onBlur} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });

  it('formats value on blur', () => {
    const onChange = vi.fn();
    render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    // Should format to 2 decimal places with commas
    expect(input).toHaveValue('50.00');
  });

  it('resets invalid input on blur', () => {
    const onChange = vi.fn();
    render(<CurrencyInput label="Amount" value={100} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    // Type gibberish that filters to empty
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.blur(input);
    // Should reset to last valid value
    expect(input).toHaveValue('100.00');
  });

  it('evaluates calculator expression on blur', () => {
    const onChange = vi.fn();
    render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '100*1.13' } });
    fireEvent.blur(input);
    // Should evaluate 100 * 1.13 = 113.00
    expect(input).toHaveValue('113.00');
    expect(onChange).toHaveBeenCalledWith(113);
  });

  it('handles allowNegative=false', () => {
    const onChange = vi.fn();
    render(<CurrencyInput label="Amount" value={0} onChange={onChange} allowNegative={false} allowCalculator={false} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '-50' } });
    // With allowNegative=false and allowCalculator=false, minus is stripped
    // The display value should be "50"
    expect(input).toHaveValue('50');
  });

  it('renders without label', () => {
    const { container } = render(<CurrencyInput value={10} onChange={vi.fn()} />);
    expect(container.querySelector('label')).toBeNull();
  });

  it('renders without prefix', () => {
    const { container } = render(<CurrencyInput label="Amount" value={10} onChange={vi.fn()} />);
    // Without prefix, no pointer-events-none span is rendered for the prefix
    const prefixSpan = container.querySelector('.pointer-events-none');
    expect(prefixSpan).toBeNull();
  });
});
