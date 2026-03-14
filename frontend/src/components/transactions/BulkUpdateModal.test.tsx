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
  FormActions: ({ onCancel, submitLabel, isSubmitting, submitDisabled }: { onCancel?: () => void; submitLabel?: string; isSubmitting?: boolean; submitDisabled?: boolean; className?: string }) => (
    <div>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" disabled={isSubmitting || submitDisabled}>{submitLabel || 'Save'}</button>
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

// Mock MultiSelect as a simple div with checkboxes
vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ placeholder, value, onChange, options }: { placeholder?: string; value: string[]; onChange: (values: string[]) => void; options: Array<{ value: string; label: string }>; disabled?: boolean }) => {
    return (
      <div data-testid="multi-select-tags">
        <span>{placeholder}</span>
        <span data-testid="multi-select-value">{value.join(',')}</span>
        {options.map((opt: { value: string; label: string }) => (
          <button
            key={opt.value}
            type="button"
            data-testid={`tag-option-${opt.value}`}
            onClick={() => onChange([...value, opt.value])}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  },
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

// Mock categories, payees, and tags APIs
const mockGetAllCategories = vi.fn().mockResolvedValue([]);
const mockGetAllPayees = vi.fn().mockResolvedValue([]);
const mockGetAllTags = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: () => mockGetAllCategories() },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: () => mockGetAllPayees() },
}));

vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: () => mockGetAllTags() },
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
    mockGetAllTags.mockResolvedValue([]);
  });

  it('renders title and selection count', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Bulk Update Transactions')).toBeInTheDocument();
    });
    expect(screen.getByText(/Update 5 selected transactions/)).toBeInTheDocument();
  });

  it('loads categories, payees, and tags when opened', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(mockGetAllCategories).toHaveBeenCalled();
      expect(mockGetAllPayees).toHaveBeenCalled();
      expect(mockGetAllTags).toHaveBeenCalled();
    });
  });

  it('shows all five toggle fields', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Payee')).toBeInTheDocument();
    });
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
  });

  it('enables field when checkbox clicked', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // All checkboxes start unchecked
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    });
    const checkboxes = screen.getAllByRole('checkbox');
    // Click the first checkbox (Payee)
    fireEvent.click(checkboxes[0]);
    // Should now show the payee combobox input
    expect(screen.getByPlaceholderText('Select or type payee name...')).toBeInTheDocument();
  });

  it('disables submit button when no fields enabled but cancel remains clickable', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Update 5 Transaction/)).toBeInTheDocument();
    });
    const submitButton = screen.getByText(/Update 5 Transaction/);
    expect(submitButton).toBeDisabled();

    // Cancel button should always be clickable
    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton).not.toBeDisabled();
    fireEvent.click(cancelButton);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows transfer note when payee enabled', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // Initially no transfer note
    await waitFor(() => {
      expect(screen.queryByText(/Transfer transactions will have their linked counterpart/)).not.toBeInTheDocument();
    });
    // Enable payee
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // Payee checkbox
    expect(screen.getByText(/Transfer transactions will have their linked counterpart/)).toBeInTheDocument();
  });

  it('shows split note when category enabled', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    // Initially no split note
    await waitFor(() => {
      expect(screen.queryByText(/Split transactions will be skipped/)).not.toBeInTheDocument();
    });
    // Enable category
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]); // Category checkbox
    expect(screen.getByText(/Split transactions will be skipped/)).toBeInTheDocument();
  });

  it('does not show transfer note when only category is enabled', async () => {
    render(<BulkUpdateModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    });
    // Enable only category (checkbox index 1)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    // Transfer note should not appear for category-only
    expect(screen.queryByText(/Transfer transactions will have their linked counterpart/)).not.toBeInTheDocument();
    // Split note should appear
    expect(screen.getByText(/Split transactions will be skipped/)).toBeInTheDocument();
  });

  it('sends payeeName along with payeeId when selecting from dropdown', async () => {
    const mockPayees = [
      { id: 'payee-1', name: 'Wealthsimple VISA', userId: 'user-1', isActive: true, defaultCategoryId: null, createdAt: '', updatedAt: '' },
    ];
    mockGetAllPayees.mockResolvedValue(mockPayees);

    const onSubmit = vi.fn().mockResolvedValue({ updated: 1, skipped: 0, skippedReasons: [] });
    render(<BulkUpdateModal {...defaultProps} onSubmit={onSubmit} />);

    // Wait for payees to load
    await waitFor(() => {
      expect(mockGetAllPayees).toHaveBeenCalled();
    });

    // Enable payee
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    // The Combobox mock fires onChange(value, label) -- simulate selecting a payee by ID
    const combobox = screen.getByPlaceholderText('Select or type payee name...');
    fireEvent.change(combobox, { target: { value: 'payee-1' } });

    // Submit
    const submitButton = screen.getByText(/Update 5 Transaction/);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeId: 'payee-1',
          payeeName: 'Wealthsimple VISA',
        }),
      );
    });
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

  it('submits tagIds when tags field is enabled', async () => {
    const mockTags = [
      { id: 'tag-1', name: 'Groceries', color: '#ff0000', icon: null, userId: 'user-1', createdAt: '', updatedAt: '' },
      { id: 'tag-2', name: 'Travel', color: '#00ff00', icon: null, userId: 'user-1', createdAt: '', updatedAt: '' },
    ];
    mockGetAllTags.mockResolvedValue(mockTags);

    const onSubmit = vi.fn().mockResolvedValue({ updated: 5, skipped: 0, skippedReasons: [] });
    render(<BulkUpdateModal {...defaultProps} onSubmit={onSubmit} />);

    // Wait for tags to load
    await waitFor(() => {
      expect(mockGetAllTags).toHaveBeenCalled();
    });

    // Enable tags field (5th checkbox, index 4)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[4]);

    // The MultiSelect should now be visible
    expect(screen.getByTestId('multi-select-tags')).toBeInTheDocument();

    // Select a tag using the mock
    const tagButton = screen.getByTestId('tag-option-tag-1');
    fireEvent.click(tagButton);

    // Submit
    const submitButton = screen.getByText(/Update 5 Transaction/);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ tagIds: ['tag-1'] });
    });
  });

  it('submits empty tagIds array when tags enabled but none selected', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ updated: 5, skipped: 0, skippedReasons: [] });
    render(<BulkUpdateModal {...defaultProps} onSubmit={onSubmit} />);

    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    });

    // Enable tags field (5th checkbox, index 4)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[4]);

    // Submit without selecting any tags (clears all tags)
    const submitButton = screen.getByText(/Update 5 Transaction/);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ tagIds: [] });
    });
  });

  it('resets form when modal closes', async () => {
    const { rerender } = render(<BulkUpdateModal {...defaultProps} isOpen={true} />);

    // Enable a field
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    });
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
