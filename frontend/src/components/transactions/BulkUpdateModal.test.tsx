import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkUpdateModal } from './BulkUpdateModal';

// Mock Modal to render children when isOpen
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; onClose: () => void; children: React.ReactNode; maxWidth?: string; className?: string }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

// Mock FormActions to render submit/cancel buttons
vi.mock('@/components/ui/FormActions', () => ({
  FormActions: ({ onCancel, submitLabel, isSubmitting, className }: { onCancel?: () => void; submitLabel?: string; isSubmitting?: boolean; className?: string }) => (
    <div className={className}>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" disabled={isSubmitting}>{submitLabel || 'Save'}</button>
    </div>
  ),
}));

// Mock Combobox as a simple input
vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ placeholder, value, onChange }: { placeholder?: string; value?: string; onChange: (value: string, label: string) => void; options?: unknown[]; onCreateNew?: (name: string) => void; allowCustomValue?: boolean }) => (
    <input
      placeholder={placeholder}
      value={value || ''}
      onChange={(e) => onChange(e.target.value, e.target.value)}
      data-testid={`combobox-${placeholder?.slice(0, 10)}`}
    />
  ),
}));

// Mock Select as a simple select
vi.mock('@/components/ui/Select', () => ({
  Select: ({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value?: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void }) => (
    <select value={value} onChange={onChange} data-testid="status-select">
      {options.map((opt: { value: string; label: string }) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  ),
}));

// Mock categories and payees APIs
const mockGetAllCategories = vi.fn().mockResolvedValue([]);
const mockGetAllPayees = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: () => mockGetAllCategories() },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: () => mockGetAllPayees() },
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: () => [],
}));

describe('BulkUpdateModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn().mockResolvedValue({ updated: 5, skipped: 0, skippedReasons: [] }),
    selectionCount: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
  });

  it('renders title and selection count', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    expect(screen.getByText('Bulk Update Transactions')).toBeInTheDocument();
    expect(screen.getByText(/Update 5 selected transactions/)).toBeInTheDocument();
  });

  it('loads categories and payees when opened', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(mockGetAllCategories).toHaveBeenCalled();
      expect(mockGetAllPayees).toHaveBeenCalled();
    });
  });

  it('shows all four toggle fields', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    expect(screen.getByText('Payee')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('enables field when checkbox clicked', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // All checkboxes start unchecked
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(4);
    // Click the first checkbox (Payee)
    fireEvent.click(checkboxes[0]);
    // Should now show the payee combobox input
    expect(screen.getByPlaceholderText('Select or type payee name...')).toBeInTheDocument();
  });

  it('disables submit when no fields enabled', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // The form actions wrapper has opacity-50 and pointer-events-none when nothing enabled
    const submitButton = screen.getByText(/Update 5 Transaction/);
    const wrapper = submitButton.parentElement;
    expect(wrapper?.className).toContain('opacity-50');
    expect(wrapper?.className).toContain('pointer-events-none');
  });

  it('shows transfer note when payee enabled', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // Initially no transfer note
    expect(screen.queryByText(/Transfer transactions will be skipped/)).not.toBeInTheDocument();
    // Enable payee
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Payee checkbox
    expect(screen.getByText(/Transfer transactions will be skipped/)).toBeInTheDocument();
  });

  it('shows split note when category enabled', () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // Initially no split note
    expect(screen.queryByText(/Split transactions will be skipped/)).not.toBeInTheDocument();
    // Enable category
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // Category checkbox
    expect(screen.getByText(/Split transactions will be skipped/)).toBeInTheDocument();
  });

  it('submits with enabled fields only', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ updated: 5, skipped: 0, skippedReasons: [] });
    render(<BulkUpdateModal {...defaultProps} onSubmit={onSubmit} />);

    // Enable description field
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[2]); // Description checkbox

    // Type in description textarea
    const textarea = screen.getByPlaceholderText('Enter description (leave empty to clear)');
    fireEvent.change(textarea, { target: { value: 'Test description' } });

    // Submit form
    const submitButton = screen.getByText(/Update 5 Transaction/);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ description: 'Test description' });
    });
  });

  it('resets form when modal closes', () => {
    const { rerender } = render(<BulkUpdateModal {...defaultProps} isOpen={true} />);

    // Enable a field
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Enable payee

    // Close modal
    rerender(<BulkUpdateModal {...defaultProps} isOpen={false} />);

    // Reopen modal
    rerender(<BulkUpdateModal {...defaultProps} isOpen={true} />);

    // All checkboxes should be unchecked again
    const newCheckboxes = screen.getAllByRole('checkbox');
    newCheckboxes.forEach((cb) => {
      expect(cb).not.toBeChecked();
    });
  });
});
