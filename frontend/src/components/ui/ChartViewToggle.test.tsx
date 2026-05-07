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

  it('renders line and area options when specified', () => {
    render(<ChartViewToggle value="line" onChange={vi.fn()} options={['line', 'area']} />);
    expect(screen.getByTitle('Line Chart')).toBeInTheDocument();
    expect(screen.getByTitle('Area Chart')).toBeInTheDocument();
  });

  it('applies custom activeColour to the active button', () => {
    render(
      <ChartViewToggle value="bar" onChange={vi.fn()} activeColour="bg-green-600" />
    );
    const barBtn = screen.getByTitle('Bar Chart');
    expect(barBtn.className).toContain('bg-green-600');
  });

  it('applies inactive style to non-active button', () => {
    render(<ChartViewToggle value="bar" onChange={vi.fn()} />);
    const pieBtn = screen.getByTitle('Pie Chart');
    expect(pieBtn.className).toContain('bg-gray-100');
  });

  it('applies custom className to container', () => {
    const { container } = render(
      <ChartViewToggle value="pie" onChange={vi.fn()} className="my-custom-class" />
    );
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
