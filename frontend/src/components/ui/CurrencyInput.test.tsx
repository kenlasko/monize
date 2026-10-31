import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CurrencyInput } from './CurrencyInput';

/**
 * A parent that actually stores what the field reports, which is what every
 * real call site is. A `vi.fn()` on its own leaves `value` frozen, so the
 * field's own re-sync effect pulls the display back to the stale number and
 * hides whatever the interaction did.
 */
function Controlled({
  label,
  initial,
  onChange,
  decimalPlaces,
}: {
  decimalPlaces?: number;
  label: string;
  initial: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const [value, setValue] = useState<number | undefined>(initial);
  return (
    <CurrencyInput
      label={label}
      decimalPlaces={decimalPlaces}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe('CurrencyInput', () => {
  it.each([
    [0, "1234.6", 1235, "1,235"],
    [3, "1.2346", 1.235, "1.235"],
    [4, "1.23456", 1.2346, "1.2346"],
  ] as const)(
    "uses the selected currency precision (%i) for edited values",
    (places, typed, expected, displayed) => {
      const onChange = vi.fn();
      render(
        <Controlled
          label="Currency amount"
          initial={undefined}
          decimalPlaces={places}
          onChange={onChange}
        />,
      );
      const input = screen.getByLabelText("Currency amount");
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenLastCalledWith(expected);
      expect(input).toHaveValue(displayed);
    },
  );

  it("preserves an untouched stored four-decimal amount in a three-decimal currency", () => {
    const onChange = vi.fn();
    render(
      <Controlled
        label="Stored amount"
        initial={1.2345}
        decimalPlaces={3}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText("Stored amount");
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange.mock.calls.every(([value]) => value === 1.2345)).toBe(true);
  });
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

  it('rounds a sub-cent typed amount to cents (parseAmount contract)', () => {
    // A money field stores what it displays (2dp); the value handed to the parent
    // must not carry sub-cent precision the 2dp display hides.
    const onChange = vi.fn();
    render(<Controlled label="Amount" initial={undefined} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: '1.239' } });
    expect(onChange).toHaveBeenLastCalledWith(1.24);
    fireEvent.blur(input);
    expect(input).toHaveValue('1.24');
    expect(onChange).toHaveBeenLastCalledWith(1.24);
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
    render(<Controlled label="Amount" initial={0} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
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
    render(<Controlled label="Amount" initial={0} onChange={onChange} />);
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '100*1.13' } });
    fireEvent.blur(input);
    // Should evaluate 100 * 1.13 = 113.00 and format
    expect(onChange).toHaveBeenCalledWith(113);
    expect(input).toHaveValue('113.00');
  });

  // A field the user tabbed through, or one whose text round-trips to the value
  // it was already showing, has not been edited. Reporting it as a change is
  // invisible to a parent that only stores the number and destructive to one
  // that does more: the FX panels derive an exchange rate from the converted
  // total and mark it user-overridden, so a bare blur replaced the fetched 10dp
  // rate with one reverse-engineered from the cents-rounded total on screen.
  describe('a blur that changes nothing does not report a change', () => {
    it('stays silent when the field is blurred untouched', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-54.61} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('-54.61');
    });

    // The server writes four-decimal amounts (an FX conversion, a transfer's
    // implied destination). The field shows two, so the untouched text parses
    // to the display, not to the value; reporting it re-amounted the row on
    // every cosmetic edit (A26-M37).
    it('stays silent when a four-decimal value is blurred untouched', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-3.3333} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('-3.33');
    });

    it('still reports an edit away from a four-decimal value', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-3.3333} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '-3.34' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenLastCalledWith(-3.34);
    });

    it('stays silent when the typed text parses back to the same value', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-54.61} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '-54.610' } });
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('stays silent when an expression evaluates to the value already held', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={113} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '100*1.13' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('113.00');
    });

    it('stays silent when an empty field is blurred while the value is undefined', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={undefined} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('still reports a real edit', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-54.61} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '-60' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenLastCalledWith(-60);
    });

    it('still reports a field the user cleared', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Total" value={-54.61} onChange={onChange} />);
      const input = screen.getByLabelText('Total');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenLastCalledWith(undefined);
    });
  });

  it('evaluates calculator expression on Enter without submitting form', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <CurrencyInput label="Amount" value={0} onChange={onChange} />
      </form>
    );
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '44*1.13' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(49.72);
    expect(input).toHaveValue('49.72');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('allows Enter to submit form when value is a plain number', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <CurrencyInput label="Amount" value={0} onChange={onChange} />
        <button type="submit">Save</button>
      </form>
    );
    const input = screen.getByLabelText('Amount');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '50' } });
    // Plain numbers should let Enter behave normally (form submit via the
    // implicit-submit pathway). We assert by simulating a form submit, which
    // would have been prevented if our handler called preventDefault.
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalled();
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
      const calcInput = screen.getByPlaceholderText('100*1.13');
      expect(calcInput).toHaveValue('50.00');
    });

    it('pre-fills empty for zero value', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
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
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '100' } });
      fireEvent.mouseDown(screen.getByLabelText('Add plus operator'));
      expect((calcInput as HTMLInputElement).value).toContain('+');
    });

    it('shows preview for valid expression', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '100+50' } });
      expect(screen.getByText('150.00')).toBeInTheDocument();
    });

    it('applies result and closes modal', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '100*1.13' } });
      fireEvent.click(screen.getByText('Apply'));
      expect(onChange).toHaveBeenCalledWith(113);
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
    });

    it('applies result on Enter key', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '200+50' } });
      fireEvent.keyDown(calcInput, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith(250);
    });

    it('closes modal on Cancel without applying', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={100} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      fireEvent.change(screen.getByPlaceholderText('100*1.13'), { target: { value: '999' } });
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
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '999' } });
      fireEvent.keyDown(calcInput, { key: 'Escape' });
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('closes modal on Enter key', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '100+50' } });
      fireEvent.keyDown(calcInput, { key: 'Enter' });
      expect(screen.queryByText('Calculator')).not.toBeInTheDocument();
    });

    it('applies plain number without expression', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} />);
      fireEvent.click(screen.getByLabelText('Open calculator'));
      const calcInput = screen.getByPlaceholderText('100*1.13');
      fireEvent.change(calcInput, { target: { value: '75' } });
      fireEvent.click(screen.getByText('Apply'));
      expect(onChange).toHaveBeenCalledWith(75);
    });

    it('disables calculator icon when input is disabled', () => {
      render(<CurrencyInput label="Amount" value={0} onChange={vi.fn()} disabled />);
      expect(screen.getByLabelText('Open calculator')).toBeDisabled();
    });
  });

  describe('sign toggle', () => {
    it('does not render the sign toggle by default', () => {
      render(<CurrencyInput label="Amount" value={50} onChange={vi.fn()} />);
      expect(screen.queryByLabelText('Change sign')).not.toBeInTheDocument();
    });

    it('renders the sign toggle when allowSignToggle is set', () => {
      render(<CurrencyInput label="Amount" value={50} onChange={vi.fn()} allowSignToggle />);
      expect(screen.getByLabelText('Change sign')).toBeInTheDocument();
    });

    it('negates a positive value when clicked', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={50} onChange={onChange} allowSignToggle />);
      fireEvent.mouseDown(screen.getByLabelText('Change sign'));
      expect(onChange).toHaveBeenCalledWith(-50);
    });

    it('makes a negative value positive when clicked', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={-50} onChange={onChange} allowSignToggle />);
      fireEvent.mouseDown(screen.getByLabelText('Change sign'));
      expect(onChange).toHaveBeenCalledWith(50);
    });

    it('toggles the display sign without onChange for a zero value', () => {
      const onChange = vi.fn();
      render(<CurrencyInput label="Amount" value={0} onChange={onChange} allowSignToggle />);
      const input = screen.getByLabelText('Amount');
      fireEvent.focus(input);
      fireEvent.mouseDown(screen.getByLabelText('Change sign'));
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('-');
    });

    it('renders both the sign toggle and the calculator button together', () => {
      render(<CurrencyInput label="Amount" value={50} onChange={vi.fn()} allowSignToggle />);
      expect(screen.getByLabelText('Change sign')).toBeInTheDocument();
      expect(screen.getByLabelText('Open calculator')).toBeInTheDocument();
    });

    it('disables the sign toggle when input is disabled', () => {
      render(<CurrencyInput label="Amount" value={50} onChange={vi.fn()} allowSignToggle disabled />);
      expect(screen.getByLabelText('Change sign')).toBeDisabled();
    });
  });
});
