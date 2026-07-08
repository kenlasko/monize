import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
] as const;

describe('WidgetSegmentedControl', () => {
  it('renders all options and marks the active one', () => {
    render(
      <WidgetSegmentedControl value="a" onChange={() => {}} options={[...OPTIONS]} />,
    );
    expect(screen.getByText('Alpha')).toHaveClass('bg-blue-600');
    expect(screen.getByText('Beta')).not.toHaveClass('bg-blue-600');
  });

  it('fires onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(
      <WidgetSegmentedControl value="a" onChange={onChange} options={[...OPTIONS]} />,
    );
    fireEvent.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
