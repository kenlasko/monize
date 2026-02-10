import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from './Select';

const options = [
  { value: 'a', label: 'Option A' },
  { value: 'b', label: 'Option B' },
  { value: 'c', label: 'Option C', disabled: true },
];

describe('Select', () => {
  it('renders options', () => {
    render(<Select options={options} />);
    expect(screen.getByText('Option A')).toBeInTheDocument();
    expect(screen.getByText('Option B')).toBeInTheDocument();
    expect(screen.getByText('Option C')).toBeInTheDocument();
  });

  it('renders with label', () => {
    render(<Select label="Country" options={options} />);
    expect(screen.getByLabelText('Country')).toBeInTheDocument();
  });

  it('shows error message', () => {
    render(<Select options={options} error="Required" />);
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('disables individual options', () => {
    render(<Select options={options} />);
    const disabledOption = screen.getByText('Option C').closest('option');
    expect(disabledOption).toBeDisabled();
  });

  it('generates id from label', () => {
    render(<Select label="Pick One" options={options} />);
    expect(screen.getByLabelText('Pick One')).toHaveAttribute('id', 'select-pick-one');
  });

  it('has displayName', () => {
    expect(Select.displayName).toBe('Select');
  });
});
