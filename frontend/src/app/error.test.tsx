import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender } from '@testing-library/react';
import { TestIntlProvider } from '@/test/intl';
import { render, screen, fireEvent } from '@/test/render';
import esCommon from '@/i18n/messages/es/common.json';
import ErrorPage from './error';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ErrorPage', () => {
  const mockReset = vi.fn();

  it('renders error heading', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders error description', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText(/An unexpected error occurred/i)).toBeInTheDocument();
  });

  it('renders Try again button', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls reset when Try again button is clicked', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('renders dashboard link', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    expect(screen.getByText('Go to Dashboard')).toBeInTheDocument();
  });

  it('does not show error digest when not present', () => {
    render(<ErrorPage error={new Error('test error')} reset={mockReset} />);
    expect(screen.queryByText(/Error ID/i)).not.toBeInTheDocument();
  });

  it('shows error digest when present', () => {
    const errorWithDigest = Object.assign(new Error('test'), { digest: 'abc123' });
    render(<ErrorPage error={errorWithDigest} reset={mockReset} />);
    expect(screen.getByText(/Error ID: abc123/i)).toBeInTheDocument();
  });

  it('renders translated copy when the active locale is not English', () => {
    rtlRender(
      <TestIntlProvider locale="es" messages={{ common: esCommon }}>
        <ErrorPage error={new Error('test error')} reset={mockReset} />
      </TestIntlProvider>,
    );
    expect(screen.getByText('Algo salió mal')).toBeInTheDocument();
    expect(screen.getByText(/Se produjo un error inesperado/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Intentar de nuevo' })).toBeInTheDocument();
  });
});
