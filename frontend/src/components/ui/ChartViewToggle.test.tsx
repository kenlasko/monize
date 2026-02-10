import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChartViewToggle } from './ChartViewToggle';

describe('ChartViewToggle', () => {
  it('renders pie and bar buttons', () => {
    render(<ChartViewToggle value="pie" onChange={vi.fn()} />);
    expect(screen.getByTitle('Pie Chart')).toBeInTheDocument();
    expect(screen.getByTitle('Bar Chart')).toBeInTheDocument();
  });

  it('calls onChange with bar when bar clicked', () => {
    const onChange = vi.fn();
    render(<ChartViewToggle value="pie" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Bar Chart'));
    expect(onChange).toHaveBeenCalledWith('bar');
  });

  it('calls onChange with pie when pie clicked', () => {
    const onChange = vi.fn();
    render(<ChartViewToggle value="bar" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Pie Chart'));
    expect(onChange).toHaveBeenCalledWith('pie');
  });
});
