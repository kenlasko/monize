import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalError from './global-error';

describe('GlobalError', () => {
  const mockReset = vi.fn();

  // GlobalError legitimately renders <html><body> (Next.js requirement).
  // Testing-library mounts it into a <div>, which trips an unavoidable
  // DOM nesting warning. Silence it.
  const originalConsoleError = console.error;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const msg = String(args[0] ?? '');
      if (msg.includes('cannot be a child of')) return;
      originalConsoleError(...args);
    });
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders error heading', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders error description', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText(/An unexpected error occurred/i)).toBeInTheDocument();
  });

  it('renders Try again button', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls reset when Try again button is clicked', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('renders dashboard link', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
  });

  it('does not show error digest when not present', () => {
    render(<GlobalError error={new Error('test error')} reset={mockReset} />);
    expect(screen.queryByText(/Error ID/i)).not.toBeInTheDocument();
  });

  it('shows error digest when present', () => {
    const errorWithDigest = Object.assign(new Error('test'), { digest: 'xyz789' });
    render(<GlobalError error={errorWithDigest} reset={mockReset} />);
    expect(screen.getByText(/Error ID: xyz789/i)).toBeInTheDocument();
  });
});
