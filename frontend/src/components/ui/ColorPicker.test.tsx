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

  it('closes picker when clicking backdrop', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    expect(screen.getByText('Custom:')).toBeInTheDocument();
    // Click the fixed inset-0 overlay (backdrop)
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);
    expect(screen.queryByText('Custom:')).not.toBeInTheDocument();
  });

  it('updates custom color input', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    // Find the text input (has placeholder #3b82f6)
    const textInput = screen.getByPlaceholderText('#3b82f6');
    fireEvent.change(textInput, { target: { value: '#aabb00' } });
    expect(textInput).toHaveValue('#aabb00');
  });

  it('rejects invalid hex in custom input', () => {
    render(<ColorPicker value="#ef4444" onChange={vi.fn()} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    const textInput = screen.getByPlaceholderText('#3b82f6');
    // The input starts with the current value
    const initialValue = textInput.getAttribute('value');
    // Type invalid characters - regex /^#[0-9A-Fa-f]{0,6}$/ should reject
    fireEvent.change(textInput, { target: { value: '#zzzzzz' } });
    // Value should remain unchanged because "z" is not valid hex
    expect(textInput).toHaveValue(initialValue);
  });

  it('applies custom color on Apply click', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ef4444" onChange={onChange} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    // Type a valid 6-digit hex
    const textInput = screen.getByPlaceholderText('#3b82f6');
    fireEvent.change(textInput, { target: { value: '#aabb00' } });
    // Click Apply
    fireEvent.click(screen.getByText('Apply'));
    expect(onChange).toHaveBeenCalledWith('#aabb00');
    // Picker should close
    expect(screen.queryByText('Custom:')).not.toBeInTheDocument();
  });

  it('does not apply incomplete hex', () => {
    const onChange = vi.fn();
    render(<ColorPicker value="#ef4444" onChange={onChange} />);
    // Open picker
    fireEvent.click(screen.getByRole('button', { name: /ef4444/i }));
    // Type an incomplete hex (less than 6 digits)
    const textInput = screen.getByPlaceholderText('#3b82f6');
    fireEvent.change(textInput, { target: { value: '#aab' } });
    // Click Apply
    fireEvent.click(screen.getByText('Apply'));
    // onChange should NOT be called for incomplete hex
    expect(onChange).not.toHaveBeenCalled();
    // Picker should remain open
    expect(screen.getByText('Custom:')).toBeInTheDocument();
  });
});
