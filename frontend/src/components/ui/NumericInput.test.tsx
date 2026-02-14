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

  it('filters non-numeric characters', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: 'abc123' } });
    // The handler filters to "123" and calls onChange with parsed value 123
    expect(onChange).toHaveBeenCalledWith(123);
  });

  it('removes minus sign when allowNegative is false', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={onChange} allowNegative={false} />);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '-5' } });
    // The minus sign is stripped, so it becomes "5" -> onChange(5)
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('limits decimal places while typing', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={onChange} decimalPlaces={2} />);
    const input = screen.getByLabelText('Qty');
    fireEvent.change(input, { target: { value: '1.123' } });
    // Should be truncated to "1.12"
    expect(input).toHaveValue('1.12');
  });

  it('formats value on blur', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={3.1} onChange={onChange} decimalPlaces={2} />);
    const input = screen.getByLabelText('Qty');
    // Focus
    fireEvent.focus(input);
    // Type a value
    fireEvent.change(input, { target: { value: '3.1' } });
    // Blur should format to 2 decimal places
    fireEvent.blur(input);
    expect(input).toHaveValue('3.10');
  });

  it('resets to last value on invalid blur', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={5} onChange={onChange} />);
    const input = screen.getByLabelText('Qty');
    fireEvent.focus(input);
    // Type invalid input
    fireEvent.change(input, { target: { value: 'abc' } });
    // Blur - should reset to formatted last valid value
    fireEvent.blur(input);
    expect(input).toHaveValue('5.00');
  });

  it('calls onChange with undefined when blurring empty input', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={undefined} onChange={onChange} />);
    const input = screen.getByLabelText('Qty');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    // Clear the input
    fireEvent.change(input, { target: { value: '' } });
    // Blur with empty value - should call onChange with undefined
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('enforces min value on change', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={onChange} min={0} allowNegative={true} />);
    // Type a value below min
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '-5' } });
    // Should call onChange with min value
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('enforces min value on blur', () => {
    const onChange = vi.fn();
    render(<NumericInput label="Qty" value={5} onChange={onChange} min={1} allowNegative={true} />);
    const input = screen.getByLabelText('Qty');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0.5' } });
    fireEvent.blur(input);
    // On blur, value 0.5 < min 1, so onChange should be called with min
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('calls onFocus callback', () => {
    const onFocus = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={vi.fn()} onFocus={onFocus} />);
    fireEvent.focus(screen.getByLabelText('Qty'));
    expect(onFocus).toHaveBeenCalled();
  });

  it('calls onBlur callback', () => {
    const onBlur = vi.fn();
    render(<NumericInput label="Qty" value={0} onChange={vi.fn()} onBlur={onBlur} />);
    const input = screen.getByLabelText('Qty');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });
});
