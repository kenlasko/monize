import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle';

const mockSetTheme = vi.fn();
let mockTheme = 'light';

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = 'light';
  });

  it('renders Light label when theme is light', () => {
    mockTheme = 'light';
    render(<ThemeToggle />);
    expect(screen.getByText('Light')).toBeInTheDocument();
  });

  it('cycles from light to dark on click', () => {
    mockTheme = 'light';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('dark');
  });

  it('shows correct title for light theme', () => {
    mockTheme = 'light';
    render(<ThemeToggle />);
    expect(screen.getByTitle('Theme: Light. Click to change.')).toBeInTheDocument();
  });

  it('renders Dark label when theme is dark', () => {
    mockTheme = 'dark';
    render(<ThemeToggle />);
    expect(screen.getByText('Dark')).toBeInTheDocument();
  });

  it('cycles from dark to system on click', () => {
    mockTheme = 'dark';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('system');
  });

  it('shows correct title for dark theme', () => {
    mockTheme = 'dark';
    render(<ThemeToggle />);
    expect(screen.getByTitle('Theme: Dark. Click to change.')).toBeInTheDocument();
  });

  it('renders System label when theme is system', () => {
    mockTheme = 'system';
    render(<ThemeToggle />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('cycles from system to light on click', () => {
    mockTheme = 'system';
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  it('shows correct title for system theme', () => {
    mockTheme = 'system';
    render(<ThemeToggle />);
    expect(screen.getByTitle('Theme: System. Click to change.')).toBeInTheDocument();
  });
});
