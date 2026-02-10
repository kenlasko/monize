import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';

const mockSetTheme = vi.fn();
vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', setTheme: mockSetTheme }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders button with theme label', () => {
    render(<ThemeToggle />);
    expect(screen.getByText('Light')).toBeInTheDocument();
  });

  it('cycles theme on click', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('shows title with current theme', () => {
    render(<ThemeToggle />);
    expect(screen.getByTitle('Theme: Light. Click to change.')).toBeInTheDocument();
  });
});
