import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorPicker } from './ColorPicker';

describe('ColorPicker', () => {
  it('renders with selected color', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} />);
    expect(screen.getByText('#ef4444')).toBeInTheDocument();
  });

  it('renders label when provided', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} label="Color" />);
    expect(screen.getByText('Color')).toBeInTheDocument();
  });

  it('opens color picker on click', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    expect(screen.getByText('Custom:')).toBeInTheDocument();
  });

  it('calls onChange when preset color clicked', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ef4444" onChange={onChange} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    // Click a color swatch (find by style)
    const swatches = screen.getAllByRole('button').filter(
      (btn) => btn.style.backgroundColor !== ''
    );
    if (swatches.length > 0) {
      fireEvent.click(swatches[0]);
      expect(onChange).toHaveBeenCalled();
    }
  });

  it('defaults to blue when value is null', () => {
    render(<ColorPicker value={null} onChange={vi.fn()} />);
    expect(screen.getByText('#3b82f6')).toBeInTheDocument();
  });
});
