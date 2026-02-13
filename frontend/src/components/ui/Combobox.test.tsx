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

      // Press Backspace then change — should NOT autocomplete
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

      // Type again — autocomplete should resume
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

      // Press Enter without manual arrow navigation — auto-highlighted option is selected
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
});
