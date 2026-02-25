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
    render(<CurrencyInput label="Amount" value={50} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    // After focus, "50.00" becomes "50.00" stripped of commas -> "50.00", then since it's not zero it stays
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);
    // Should format to 2 decimal places
    expect(input).toHaveValue('50.00');
    expect(onChange).toHaveBeenCalledWith(50);
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
    render(<CurrencyInput label="Amount" value={113} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '100*1.13' } });
    fireEvent.blur(input);
    // Should evaluate 100 * 1.13 = 113.00 and format
    // onChange is called with 113 and display re-syncs with value prop (113)
    expect(onChange).toHaveBeenCalledWith(113);
    expect(input).toHaveValue('113.00');
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

  describe('calculator modal', () => {
    it('shows calculator icon when allowCalculator is true', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      expect(screen.getByLabelText('Open calculator')).toBeInTheDocument();
    });

    it('does not show calculator icon when allowCalculator is false', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} allowCalculator={false} />);
      expect(screen.queryByLabelText('Open calculator')).not.toBeInTheDocument();
    });

    it('opens modal when calculator icon is clicked', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      expect(screen.getByText('Calculator')).toBeInTheDocument();
    });

    it('pre-fills expression with current value', () => {
      render(<CurrencyInput label="Amount" value={50} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      expect(calcInput).toHaveValue('50.00');
    });

    it('pre-fills empty for zero value', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      expect(calcInput).toHaveValue('');
    });

    it('renders all 4 operator buttons in modal', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));

      expect(screen.getByLabelText('Add plus operator')).toBeInTheDocument();
      expect(screen.getByLabelText('Add minus operator')).toBeInTheDocument();
      expect(screen.getByLabelText('Add multiply operator')).toBeInTheDocument();
      expect(screen.getByLabelText('Add divide operator')).toBeInTheDocument();
    });

    it('inserts operator into expression via button', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '100' } });
      fireEvent.mouseDown(screen.getByLabelText('Add plus operator'));
      expect((calcInput as HTMLInputElement).value).toContain('+');
    });

    it('shows preview for valid expression', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '100+50' } });
      expect(screen.getByText('150.00')).toBeInTheDocument();
    });

    it('applies result and closes modal', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '100*1.13' } });
      fireEvent.click(screen.getByText('Apply'));
      expect(onChange).toHaveBeenCalledWith(113);
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
    });

    it('applies result on Enter key', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '200+50' } });
      fireEvent.keyDown(calcInput, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith(250);
    });

    it('closes modal on Cancel without applying', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={100} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      fireEvent.change(screen.getByPlaceholderText('e.g. 100*1.13'), { target: { value: '999' } });
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('disables Apply when expression is empty', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      expect(screen.getByText('Apply')).toBeDisabled();
    });

    it('closes modal on Escape key without applying', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={100} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      expect(screen.getByText('Calculator')).toBeInTheDocument();
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '999' } });
      fireEvent.keyDown(calcInput, { key: 'Escape' });
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('closes modal on Enter key', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '100+50' } });
      fireEvent.keyDown(calcInput, { key: 'Enter' });
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
    });

    it('applies plain number without expression', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('e.g. 100*1.13');
      fireEvent.change(calcInput, { target: { value: '75' } });
      fireEvent.click(screen.getByText('Apply'));
      expect(onChange).toHaveBeenCalledWith(75);
    });

    it('disables calculator icon when input is disabled', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} disabled />);
      expect(screen.getByLabelText('Open calculator')).toBeDisabled();
    });
  });
});
