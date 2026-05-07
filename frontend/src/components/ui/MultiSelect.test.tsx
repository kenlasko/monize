import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
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

  it('does not open dropdown when disabled and clicked', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} disabled />,
    );

    // The button is disabled so the click won't fire, but the inline guard
    // `!disabled && setIsOpen` should also prevent opening.
    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('renders without label when label prop is omitted', () => {
    const { container } = render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    expect(container.querySelector('label')).toBeNull();
  });

  it('hides search input when showSearch is false', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} showSearch={false} />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
    // Options are still displayed
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('shows placeholder text when no items are selected', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} placeholder="Pick one" />,
    );

    expect(screen.getByText('Pick one')).toBeInTheDocument();
  });

  it('shows "1 selected" when selected value does not match any option', () => {
    render(
      <MultiSelect options={flatOptions} value={['unknown']} onChange={onChange} />,
    );

    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('clears search text via the clear button inside the search input', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'alp' } });

    // The X clear button should appear
    const _clearBtn = screen.getAllByRole('button').find(
      (b) => !b.getAttribute('type') || b.getAttribute('type') === 'button',
    );
    // Find the svg-only clear button (it renders after the search input)
    const allButtons = screen.getAllByRole('button');
    // The clear-search button is the last button inside the dropdown area
    const clearSearchBtn = allButtons.find((b) => b.className.includes('absolute'));
    expect(clearSearchBtn).toBeDefined();
    fireEvent.click(clearSearchBtn!);

    expect(searchInput).toHaveValue('');
    // All options should be visible again after clearing
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('shows parent label context when searching hierarchical options', async () => {
    render(
      <MultiSelect options={hierarchicalOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'fruit' } });

    await waitFor(() => {
      expect(screen.getByText('Fruit')).toBeInTheDocument();
      // Parent label "Food" should appear as context
      expect(screen.getByText(/food/i)).toBeInTheDocument();
    });
  });

  it('shows "No options found" with onCreateNew available still shows create button', () => {
    const onCreateNew = vi.fn();
    render(
      <MultiSelect
        options={flatOptions}
        value={[]}
        onChange={onChange}
        onCreateNew={onCreateNew}
        createNewLabel="Add category"
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    // Search for something that returns no results
    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'zzz' } });

    expect(screen.getByText('No options found')).toBeInTheDocument();
    expect(screen.getByText('Add category')).toBeInTheDocument();
  });

  it('calls onCreateNew and closes dropdown when create button clicked', () => {
    const onCreateNew = vi.fn();
    render(
      <MultiSelect
        options={flatOptions}
        value={[]}
        onChange={onChange}
        onCreateNew={onCreateNew}
        createNewLabel="Create new..."
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Create new...')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Create new...'));

    expect(onCreateNew).toHaveBeenCalledOnce();
    // Dropdown should have closed
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('shows "No options found" when no options and no onCreateNew', () => {
    render(
      <MultiSelect options={[]} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('No options found')).toBeInTheDocument();
  });

  it('unchecks parent and all descendants when parent is deselected', () => {
    render(
      <MultiSelect
        options={hierarchicalOptions}
        value={['food', 'fruit', 'meat']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const checkboxes = screen.getAllByRole('checkbox');
    // Order: Food(0), Fruit(1), Meat(2), Transport(3), Bus(4), Train(5)
    fireEvent.click(checkboxes[0]); // Uncheck Food (currently selected)

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows indeterminate state when only some children are selected', () => {
    // Render with only one child selected - parent should be indeterminate
    render(
      <MultiSelect
        options={hierarchicalOptions}
        value={['fruit']} // only fruit, not meat
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const checkboxes = screen.getAllByRole('checkbox');
    // Food checkbox (index 0) should be indeterminate
    expect((checkboxes[0] as HTMLInputElement).indeterminate).toBe(true);
  });

  it('adds parent when all children become selected via child toggle', () => {
    // Start with fruit selected, now select meat → parent food should also be added
    render(
      <MultiSelect
        options={hierarchicalOptions}
        value={['fruit']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const checkboxes = screen.getAllByRole('checkbox');
    // Meat is index 2
    fireEvent.click(checkboxes[2]); // Select Meat

    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(['fruit', 'meat', 'food']));
  });

  it('removes parent when a child is deselected (not all children selected)', () => {
    // Start with all food children + parent selected; deselect one child
    render(
      <MultiSelect
        options={hierarchicalOptions}
        value={['food', 'fruit', 'meat']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    const checkboxes = screen.getAllByRole('checkbox');
    // Fruit is index 1
    fireEvent.click(checkboxes[1]); // Deselect Fruit

    const result = onChange.mock.calls[0][0] as string[];
    expect(result).toContain('meat');
    expect(result).not.toContain('fruit');
    expect(result).not.toContain('food'); // parent removed
  });

  it('closes dropdown and clears search on click outside', async () => {
    render(
      <div>
        <MultiSelect options={flatOptions} value={[]} onChange={onChange} />
        <div data-testid="outside">Outside</div>
      </div>,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'alp' } });
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId('outside'));
    });

    await waitFor(() => {
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });
  });

  it('closes dropdown on window scroll (scroll not on dropdown itself)', async () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    // Dispatch a scroll event on the document element (outside the dropdown portal).
    // The handler guards against events originating inside dropdownRef, so an
    // event dispatched on document.documentElement is treated as an outside scroll.
    await act(async () => {
      document.documentElement.dispatchEvent(new Event('scroll', { bubbles: false }));
    });

    await waitFor(() => {
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });
  });

  it('closes dropdown when trigger is clicked a second time (toggle off)', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    // This also implicitly validates that re-opening works after the same trigger
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger); // open
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    fireEvent.click(trigger); // close via toggle
    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
  });

  it('toggles dropdown closed when trigger is clicked again', () => {
    render(
      <MultiSelect options={flatOptions} value={[]} onChange={onChange} />,
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('only removes visible (filtered) options on Clear when search is active', () => {
    render(
      <MultiSelect options={flatOptions} value={['a', 'b', 'c']} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    // Search to filter down to only Beta
    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'beta' } });

    fireEvent.click(screen.getByText('Clear'));

    // Only 'b' (Beta) should be removed; 'a' and 'c' should remain
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('only adds visible (filtered) options on Select All when search is active', () => {
    render(
      <MultiSelect options={flatOptions} value={['c']} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    fireEvent.change(searchInput, { target: { value: 'alpha' } });

    fireEvent.click(screen.getByText('Select All'));

    // Only 'a' (Alpha) should be added; 'c' should be preserved
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining(['a', 'c']));
    expect(onChange).not.toHaveBeenCalledWith(expect.arrayContaining(['b']));
  });
});
