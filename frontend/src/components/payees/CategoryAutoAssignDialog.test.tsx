import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { CategoryAutoAssignDialog } from './CategoryAutoAssignDialog';

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getCategorySuggestions: vi.fn().mockResolvedValue([]),
    applyCategorySuggestions: vi.fn().mockResolvedValue({ updated: 0 }),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('CategoryAutoAssignDialog', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  it('renders dialog when open', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Auto-Assign Default Categories')).toBeInTheDocument();
    expect(screen.getByText('How it works')).toBeInTheDocument();
  });

  it('shows settings controls', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText(/Minimum Transactions/)).toBeInTheDocument();
    expect(screen.getByText(/Category Match Percentage/)).toBeInTheDocument();
    expect(screen.getByText('Only payees without a default category')).toBeInTheDocument();
  });

  it('shows preview button', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Preview Suggestions')).toBeInTheDocument();
  });

  it('renders cancel button', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});
