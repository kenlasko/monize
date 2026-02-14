import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { Combobox } from '@/components/ui/Combobox';

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const options = [
  { value: '1', label: 'Apple' },
  { value: '2', label: 'Banana' },
  { value: '3', label: 'Cherry' },
  { value: '4', label: 'Date', subtitle: 'A tropical fruit' },
];

describe('Combobox', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with label and placeholder', () => {
    render(
      <Combobox label="Fruit" placeholder="Pick a fruit" options={options} onChange={onChange} />,
    );

    expect(screen.getByText('Fruit')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Pick a fruit')).toBeInTheDocument();
  });

  it('shows options when input is focused', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByText('Banana')).toBeInTheDocument();
    expect(screen.getByText('Cherry')).toBeInTheDocument();
    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('filters options when typing', async () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // Need a small delay to clear justOpenedRef
    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'ban' } });

    await waitFor(() => {
      expect(screen.getByText('Banana')).toBeInTheDocument();
      expect(screen.queryByText('Apple')).not.toBeInTheDocument();
      expect(screen.queryByText('Cherry')).not.toBeInTheDocument();
    });
  });

  it('selects option on click', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    fireEvent.click(screen.getByText('Banana'));

    expect(onChange).toHaveBeenCalledWith('2', 'Banana');
    expect(input).toHaveValue('Banana');
  });

  it('shows error message when error prop is provided', () => {
    render(<Combobox options={options} onChange={onChange} error="Required field" />);

    expect(screen.getByText('Required field')).toBeInTheDocument();
  });

  it('shows create option when allowCustomValue is true and no exact match', async () => {
    const onCreateNew = vi.fn();

    render(
      <Combobox
        options={options}
        onChange={onChange}
        allowCustomValue
        onCreateNew={onCreateNew}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'Mango' } });

    await waitFor(() => {
      expect(screen.getByText(/Create "Mango"/)).toBeInTheDocument();
    });
  });

  it('handles keyboard navigation with ArrowDown and Enter', async () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // Press ArrowDown to highlight first option
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Press ArrowDown again to highlight second option
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Press Enter to select highlighted option
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('2', 'Banana');
  });

  it('closes dropdown on Escape', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    expect(screen.getByText('Apple')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByText('Apple')).not.toBeInTheDocument();
  });

  it('disables input when disabled prop is true', () => {
    render(<Combobox options={options} onChange={onChange} disabled />);

    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('resets input value to selected label on Escape', () => {
    render(<Combobox options={options} onChange={onChange} value="2" initialDisplayValue="Banana" />);

    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('Banana');

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).toHaveValue('Banana');
  });

  it('opens dropdown on ArrowDown when closed', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');

    // Dropdown should be closed initially (no options visible)
    expect(screen.queryByText('Apple')).not.toBeInTheDocument();

    // ArrowDown should open the dropdown
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.getByText('Apple')).toBeInTheDocument();
  });

  it('opens dropdown on ArrowUp when closed', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');

    expect(screen.queryByText('Apple')).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(screen.getByText('Apple')).toBeInTheDocument();
  });

  it('ArrowUp does not go below index 0', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // Highlight first option
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Try to go up from index 0
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // Enter should still select the first option
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('1', 'Apple');
  });

  it('ArrowDown does not go past last option', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // Navigate past all options
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // One more should stay on last
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Should select the last option (Date, index 3)
    expect(onChange).toHaveBeenCalledWith('4', 'Date');
  });

  it('clicking on already-focused input re-opens dropdown', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    expect(screen.getByText('Apple')).toBeInTheDocument();

    // Select an option to close dropdown
    fireEvent.click(screen.getByText('Banana'));
    expect(screen.queryByText('Apple')).not.toBeInTheDocument();

    // Click input again
    fireEvent.click(input);
    expect(screen.getByText('Apple')).toBeInTheDocument();
  });

  it('calls onCreateNew when create option is clicked', async () => {
    const onCreateNew = vi.fn();

    render(
      <Combobox
        options={options}
        onChange={onChange}
        allowCustomValue
        onCreateNew={onCreateNew}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'Mango' } });

    await waitFor(() => {
      expect(screen.getByText(/Create "Mango"/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Create "Mango"/));

    expect(onCreateNew).toHaveBeenCalledWith('Mango');
  });

  it('falls back to onChange when onCreateNew is not provided for custom value', async () => {
    render(
      <Combobox
        options={options}
        onChange={onChange}
        allowCustomValue
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'Mango' } });

    await waitFor(() => {
      expect(screen.getByText(/Create "Mango"/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Create "Mango"/));

    // Without onCreateNew, it should call onChange with empty value and the label
    expect(onChange).toHaveBeenCalledWith('', 'Mango');
  });

  it('closes dropdown when clicking outside', async () => {
    render(
      <div>
        <Combobox options={options} onChange={onChange} />
        <button data-testid="outside">Outside</button>
      </div>,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    expect(screen.getByText('Apple')).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(screen.getByTestId('outside'));

    await waitFor(() => {
      expect(screen.queryByText('Apple')).not.toBeInTheDocument();
    });
  });

  it('resets to selected value on click outside when not allowing custom values', async () => {
    render(
      <div>
        <Combobox options={options} onChange={onChange} value="1" initialDisplayValue="Apple" />
        <button data-testid="outside">Outside</button>
      </div>,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    // Type something different
    fireEvent.change(input, { target: { value: 'xyz' } });

    // Click outside
    fireEvent.mouseDown(screen.getByTestId('outside'));

    await waitFor(() => {
      // Should revert to the selected label
      expect(input).toHaveValue('Apple');
    });
  });

  it('displays initial value from initialDisplayValue prop', () => {
    render(
      <Combobox
        options={options}
        onChange={onChange}
        value="1"
        initialDisplayValue="Apple"
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('Apple');
  });

  it('updates input when value prop changes', () => {
    const { rerender } = render(
      <Combobox
        options={options}
        onChange={onChange}
        value="1"
        initialDisplayValue="Apple"
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('Apple');

    rerender(
      <Combobox
        options={options}
        onChange={onChange}
        value="2"
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('Banana');
  });

  it('shows checkmark on selected option', () => {
    const { container } = render(
      <Combobox options={options} onChange={onChange} value="2" initialDisplayValue="Banana" />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // The selected option should have the checkmark svg
    const bananaOption = screen.getByText('Banana').closest('[data-option-index]');
    expect(bananaOption).toBeInTheDocument();
    const checkmark = bananaOption?.querySelector('svg');
    expect(checkmark).toBeInTheDocument();
  });

  it('does not show create option when input matches an existing option exactly', async () => {
    render(
      <Combobox
        options={options}
        onChange={onChange}
        allowCustomValue
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'Apple' } });

    await waitFor(() => {
      expect(screen.queryByText(/Create "Apple"/)).not.toBeInTheDocument();
    });
  });

  it('renders without label', () => {
    render(<Combobox options={options} onChange={onChange} />);

    // Should not have any label elements
    expect(screen.queryByText('Fruit')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('uses default placeholder when none provided', () => {
    render(<Combobox options={options} onChange={onChange} />);

    expect(screen.getByPlaceholderText('Select or type...')).toBeInTheDocument();
  });

  it('calls onInputChange when typing', async () => {
    const onInputChange = vi.fn();

    render(
      <Combobox options={options} onChange={onChange} onInputChange={onInputChange} />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'ban' } });

    expect(onInputChange).toHaveBeenCalledWith('ban');
  });

  it('filters by subtitle content', async () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'tropical' } });

    await waitFor(() => {
      // Date has subtitle "A tropical fruit" which matches
      expect(screen.getByText('Date')).toBeInTheDocument();
      // Others should be filtered out
      expect(screen.queryByText('Apple')).not.toBeInTheDocument();
      expect(screen.queryByText('Banana')).not.toBeInTheDocument();
    });
  });

  it('shows subtitle text when filtering', async () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'dat' } });

    await waitFor(() => {
      expect(screen.getByText('A tropical fruit')).toBeInTheDocument();
    });
  });

  it('handles custom value on click-outside with allowCustomValue', async () => {
    render(
      <div>
        <Combobox options={options} onChange={onChange} allowCustomValue />
        <button data-testid="outside">Outside</button>
      </div>,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'Custom Fruit' } });

    // Click outside
    fireEvent.mouseDown(screen.getByTestId('outside'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('', 'Custom Fruit');
    });
  });

  it('matches exact option on click-outside with allowCustomValue', async () => {
    render(
      <div>
        <Combobox options={options} onChange={onChange} allowCustomValue />
        <button data-testid="outside">Outside</button>
      </div>,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    await new Promise(r => setTimeout(r, 150));

    // Type an existing option name exactly (case-insensitive)
    fireEvent.change(input, { target: { value: 'apple' } });

    // Click outside
    fireEvent.mouseDown(screen.getByTestId('outside'));

    await waitFor(() => {
      // Should match and select the existing Apple option
      expect(onChange).toHaveBeenCalledWith('1', 'Apple');
    });
  });

  it('Enter with no highlighted option does nothing', () => {
    render(<Combobox options={options} onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);

    // highlightedIndex is -1 initially when not typing
    // Press Enter without highlighting anything
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears value when value prop becomes empty without allowCustomValue', () => {
    const { rerender } = render(
      <Combobox
        options={options}
        onChange={onChange}
        value="1"
        initialDisplayValue="Apple"
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('Apple');

    rerender(
      <Combobox
        options={options}
        onChange={onChange}
        value=""
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  describe('inline autocomplete', () => {
    it('autocompletes input with best prefix match', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ba' } });

      await waitFor(() => {
        expect(input).toHaveValue('Banana');
      });
    });

    it('autocompletes case-insensitively', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ch' } });

      await waitFor(() => {
        expect(input).toHaveValue('Cherry');
      });
    });

    it('does not autocomplete on backspace', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      // Type "ba" to trigger autocomplete
      fireEvent.change(input, { target: { value: 'ba' } });
      await waitFor(() => expect(input).toHaveValue('Banana'));

      // Press Backspace then change -- should NOT autocomplete
      fireEvent.keyDown(input, { key: 'Backspace' });
      fireEvent.change(input, { target: { value: 'b' } });

      await waitFor(() => {
        expect(input).toHaveValue('b');
      });
    });

    it('does not autocomplete on delete key', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ba' } });
      await waitFor(() => expect(input).toHaveValue('Banana'));

      fireEvent.keyDown(input, { key: 'Delete' });
      fireEvent.change(input, { target: { value: 'b' } });

      await waitFor(() => {
        expect(input).toHaveValue('b');
      });
    });

    it('does not autocomplete when no prefix match exists', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'xyz' } });

      await waitFor(() => {
        expect(input).toHaveValue('xyz');
      });
    });

    it('does not autocomplete empty input', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: '' } });

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });

    it('resumes autocomplete after backspace when typing new characters', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      // Type, backspace, then type again
      fireEvent.change(input, { target: { value: 'ba' } });
      await waitFor(() => expect(input).toHaveValue('Banana'));

      fireEvent.keyDown(input, { key: 'Backspace' });
      fireEvent.change(input, { target: { value: 'b' } });
      await waitFor(() => expect(input).toHaveValue('b'));

      // Type again -- autocomplete should resume
      fireEvent.change(input, { target: { value: 'ba' } });
      await waitFor(() => {
        expect(input).toHaveValue('Banana');
      });
    });
  });

  describe('prefix-first sorting', () => {
    it('sorts prefix matches before substring matches in dropdown', async () => {
      const mixedOptions = [
        { value: '1', label: 'Pineapple' },
        { value: '2', label: 'Apple' },
        { value: '3', label: 'Crabapple' },
      ];

      const { container } = render(
        <Combobox options={mixedOptions} onChange={onChange} />,
      );
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'app' } });

      await waitFor(() => {
        const optionElements = container.querySelectorAll('[data-option-index]');
        // "Apple" (prefix) should come first, then substring matches alphabetically
        expect(optionElements[0]).toHaveTextContent('Apple');
        expect(optionElements[1]).toHaveTextContent('Crabapple');
        expect(optionElements[2]).toHaveTextContent('Pineapple');
      });
    });

    it('maintains alphabetical order among prefix matches', async () => {
      const sortOptions = [
        { value: '1', label: 'Chestnut' },
        { value: '2', label: 'Cherry' },
        { value: '3', label: 'Chocolate' },
      ];

      const { container } = render(
        <Combobox options={sortOptions} onChange={onChange} />,
      );
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ch' } });

      await waitFor(() => {
        const optionElements = container.querySelectorAll('[data-option-index]');
        expect(optionElements[0]).toHaveTextContent('Cherry');
        expect(optionElements[1]).toHaveTextContent('Chestnut');
        expect(optionElements[2]).toHaveTextContent('Chocolate');
      });
    });
  });

  describe('auto-highlight', () => {
    it('highlights the first filtered option while typing', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ch' } });

      await waitFor(() => {
        const cherryOption = screen.getByText('Cherry').closest('[data-option-index]');
        expect(cherryOption).toHaveClass('bg-blue-100');
      });
    });

    it('highlights first prefix match over substring matches', async () => {
      const mixedOptions = [
        { value: '1', label: 'Pineapple' },
        { value: '2', label: 'Apple' },
      ];

      render(<Combobox options={mixedOptions} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'app' } });

      await waitFor(() => {
        // Apple (prefix match, sorted first) should be highlighted
        const appleOption = screen.getByText('Apple').closest('[data-option-index]');
        expect(appleOption).toHaveClass('bg-blue-100');
      });
    });

    it('arrow keys move highlight away from auto-highlighted first option', async () => {
      const manyOptions = [
        { value: '1', label: 'Alpha' },
        { value: '2', label: 'Apex' },
        { value: '3', label: 'April' },
      ];

      render(<Combobox options={manyOptions} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'a' } });

      await waitFor(() => {
        // First option auto-highlighted
        const firstOption = screen.getByText('Alpha').closest('[data-option-index]');
        expect(firstOption).toHaveClass('bg-blue-100');
      });

      // ArrowDown should move highlight to second option
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        const secondOption = screen.getByText('Apex').closest('[data-option-index]');
        expect(secondOption).toHaveClass('bg-blue-100');
        // First option should no longer be highlighted
        const firstOption = screen.getByText('Alpha').closest('[data-option-index]');
        expect(firstOption).not.toHaveClass('bg-blue-100');
      });

      // ArrowDown again to third option
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        const thirdOption = screen.getByText('April').closest('[data-option-index]');
        expect(thirdOption).toHaveClass('bg-blue-100');
      });

      // ArrowUp back to second
      fireEvent.keyDown(input, { key: 'ArrowUp' });

      await waitFor(() => {
        const secondOption = screen.getByText('Apex').closest('[data-option-index]');
        expect(secondOption).toHaveClass('bg-blue-100');
      });
    });

    it('Enter selects the arrow-navigated option, not the first', async () => {
      const manyOptions = [
        { value: '1', label: 'Alpha' },
        { value: '2', label: 'Apex' },
        { value: '3', label: 'April' },
      ];

      render(<Combobox options={manyOptions} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'a' } });

      await waitFor(() => {
        expect(screen.getByText('Alpha')).toBeInTheDocument();
      });

      // Navigate to second option and select it
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onChange).toHaveBeenCalledWith('2', 'Apex');
    });

    it('auto-selects via Enter after typing triggers auto-highlight', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ch' } });

      await waitFor(() => {
        expect(screen.getByText('Cherry')).toBeInTheDocument();
      });

      // Press Enter without manual arrow navigation -- auto-highlighted option is selected
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onChange).toHaveBeenCalledWith('3', 'Cherry');
    });
  });

  describe('Tab key behavior', () => {
    it('accepts the auto-highlighted option on Tab', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'ch' } });

      await waitFor(() => {
        expect(screen.getByText('Cherry')).toBeInTheDocument();
      });

      fireEvent.keyDown(input, { key: 'Tab' });

      expect(onChange).toHaveBeenCalledWith('3', 'Cherry');
    });

    it('closes dropdown on Tab', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);

      expect(screen.getByText('Apple')).toBeInTheDocument();

      fireEvent.keyDown(input, { key: 'Tab' });

      await waitFor(() => {
        expect(screen.queryByText('Apple')).not.toBeInTheDocument();
      });
    });

    it('accepts create option on Tab when highlighted', async () => {
      const onCreateNew = vi.fn();

      render(
        <Combobox
          options={options}
          onChange={onChange}
          allowCustomValue
          onCreateNew={onCreateNew}
        />,
      );
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'Mango' } });

      await waitFor(() => {
        expect(screen.getByText(/Create "Mango"/)).toBeInTheDocument();
      });

      // Navigate to highlight "Create" option (it has no auto-highlight since no filtered matches)
      // With no filtered options matching, highlightedIndex stays -1
      // Tab should just close without calling create
      fireEvent.keyDown(input, { key: 'Tab' });

      await waitFor(() => {
        expect(screen.queryByText(/Create "Mango"/)).not.toBeInTheDocument();
      });
    });

    it('does not call onChange when Tab is pressed without typing', async () => {
      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);

      fireEvent.keyDown(input, { key: 'Tab' });

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('create option keyboard navigation', () => {
    it('selects create option via Enter when highlighted at index 0', async () => {
      const onCreateNew = vi.fn();

      // Use options where the typed text is a substring but not a prefix,
      // so inline autocomplete does not create an exact match
      render(
        <Combobox
          options={[
            { value: '1', label: 'Big Apple' },
          ]}
          onChange={onChange}
          allowCustomValue
          onCreateNew={onCreateNew}
        />,
      );

      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      // "app" matches "Big Apple" as substring but is not a prefix, so no autocomplete
      // and input value stays "app" (not exact match) so Create option appears
      fireEvent.change(input, { target: { value: 'app' } });

      await waitFor(() => {
        expect(screen.getByText(/Create "app"/)).toBeInTheDocument();
        expect(screen.getByText('Big Apple')).toBeInTheDocument();
      });

      // Create option is at index 0, first matched option is at index 1
      // Auto-highlight goes to index 1 (first filtered option)
      // Navigate up to create option at index 0
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onCreateNew).toHaveBeenCalledWith('app');
    });

    it('selects create option via Tab when highlighted at index 0', async () => {
      const onCreateNew = vi.fn();

      render(
        <Combobox
          options={[
            { value: '1', label: 'Big Apple' },
          ]}
          onChange={onChange}
          allowCustomValue
          onCreateNew={onCreateNew}
        />,
      );

      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      await new Promise(r => setTimeout(r, 150));

      fireEvent.change(input, { target: { value: 'app' } });

      await waitFor(() => {
        expect(screen.getByText(/Create "app"/)).toBeInTheDocument();
      });

      // Navigate up to index 0 (create option)
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Tab' });

      expect(onCreateNew).toHaveBeenCalledWith('app');
    });
  });

  describe('scrollIntoView behavior', () => {
    it('scrolls highlighted item into view during keyboard navigation', async () => {
      const scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy;

      render(<Combobox options={options} onChange={onChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.focus(input);

      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        expect(scrollSpy).toHaveBeenCalled();
      });
    });
  });
});
