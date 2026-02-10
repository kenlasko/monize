import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';

const flatOptions: MultiSelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

const hierarchicalOptions: MultiSelectOption[] = [
  {
    value: 'food',
    label: 'Food',
    children: [
      { value: 'fruit', label: 'Fruit', parentId: 'food' },
      { value: 'meat', label: 'Meat', parentId: 'food' },
    ],
  },
  {
    value: 'transport',
    label: 'Transport',
    children: [
      { value: 'bus', label: 'Bus', parentId: 'transport' },
      { value: 'train', label: 'Train', parentId: 'transport' },
    ],
  },
];

describe('MultiSelect', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with label and placeholder', () => {
    render(
      <MultiSelect
        label="Categories"
        placeholder="Choose categories"
        options={flatOptions}
        value={[]}
        onChange={onChange}
      />,
    );

    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Choose categories')).toBeInTheDocument();
  });

  it('shows selected count in trigger when multiple items selected', () => {
    render(
      <MultiSelect options={flatOptions} value={['a', 'b']} onChange={onChange} />,
    );

    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('shows single option label when one item is selected', () => {
    render(
      <MultiSelect options={flatOptions} value={['b']} onChange={onChange} />,
    );

    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('opens dropdown and shows options when clicked', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });

  it('toggles selection when checkbox is clicked', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Click Alpha

    expect(onChange).toHaveBeenCalledWith(['a']);
  });

  it('removes item from selection when unchecked', () => {
    render(
      <MultiSelect options={flatOptions} value={['a', 'b']} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    // Find the Alpha checkbox (first one)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Uncheck Alpha

    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  it('filters options with search input', async () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'alp' } });

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByText('Beta')).not.toBeInTheDocument();
      expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    });
  });

  it('shows "No options found" when search has no results', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'zzz' } });

    expect(screen.getByText('No options found')).toBeInTheDocument();
  });

  it('selects all visible options with Select All button', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Select All'));

    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('clears all visible options with Clear button', () => {
    render(
      <MultiSelect options={flatOptions} value={['a', 'b', 'c']} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Clear'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('handles hierarchical options - toggling parent selects children', () => {
    render(
      <MultiSelect options={hierarchicalOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    // Find the Food parent checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    // Order: Food, Fruit, Meat, Transport, Bus, Train
    fireEvent.click(checkboxes[0]); // Click Food

    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(['food', 'fruit', 'meat']));
  });

  it('shows error message when error prop is provided', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} error="At least one required" />,
    );

    expect(screen.getByText('At least one required')).toBeInTheDocument();
  });

  it('is disabled when disabled prop is true', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} disabled />,
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });
});
