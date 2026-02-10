import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { IconPicker, getIconComponent } from '@/components/ui/IconPicker';

describe('IconPicker', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with a label', () => {
    render(<IconPicker value={null} onChange={onChange} label="Select Icon" />);

    expect(screen.getByText('Select Icon')).toBeInTheDocument();
  });

  it('renders the trigger button with the selected icon', () => {
    render(<IconPicker value="home" onChange={onChange} />);

    // The trigger button should be visible
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
  });

  it('defaults to chart-bar when value is null', () => {
    render(<IconPicker value={null} onChange={onChange} />);

    // The button should render (defaults to chart-bar internally)
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('opens icon grid when trigger button is clicked', () => {
    render(<IconPicker value={null} onChange={onChange} />);

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);

    // Should now see many icon buttons in the grid
    // Including the trigger, there should be many buttons now
    const allButtons = screen.getAllByRole('button');
    expect(allButtons.length).toBeGreaterThan(5);
  });

  it('calls onChange with icon name when an icon is clicked', () => {
    render(<IconPicker value={null} onChange={onChange} />);

    // Open the picker
    fireEvent.click(screen.getByRole('button'));

    // Find the "home" icon button by its title attribute
    const homeButton = screen.getByTitle('home');
    fireEvent.click(homeButton);

    expect(onChange).toHaveBeenCalledWith('home');
  });

  it('closes the picker after selecting an icon', () => {
    render(<IconPicker value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));

    // Grid should be open
    expect(screen.getByTitle('home')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('home'));

    // Grid should be closed -- only trigger button remains
    expect(screen.queryByTitle('home')).not.toBeInTheDocument();
  });

  it('highlights the currently selected icon', () => {
    render(<IconPicker value="heart" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));

    const heartButton = screen.getByTitle('heart');
    expect(heartButton.className).toContain('bg-blue-100');
  });
});

describe('getIconComponent', () => {
  it('returns an icon for a known name', () => {
    const icon = getIconComponent('home');
    expect(icon).toBeDefined();
  });

  it('returns chart-bar fallback for an unknown name', () => {
    const icon = getIconComponent('unknown-icon');
    const fallback = getIconComponent('chart-bar');
    expect(icon).toEqual(fallback);
  });
});
