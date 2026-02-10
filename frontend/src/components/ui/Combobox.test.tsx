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
});
