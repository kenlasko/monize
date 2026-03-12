import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { TagForm } from './TagForm';
import { Tag } from '@/types/tag';

vi.mock('@/lib/zodConfig', () => ({}));

vi.mock('@/components/ui/ColorPicker', () => ({
  ColorPicker: ({ value, onChange, label }: any) => (
    <div data-testid="color-picker">
      <span>{label}</span>
      <input
        data-testid="color-picker-input"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));

vi.mock('@/components/ui/IconPicker', () => ({
  IconPicker: ({ value, onChange, label }: any) => (
    <div data-testid="icon-picker">
      <span>{label}</span>
      <input
        data-testid="icon-picker-input"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));

vi.mock('@/components/ui/FormActions', () => ({
  FormActions: ({ onCancel, submitLabel, isSubmitting }: any) => (
    <div data-testid="form-actions">
      <button type="button" onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </button>
      <button type="submit" disabled={isSubmitting}>
        {submitLabel}
      </button>
    </div>
  ),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => {
    const errors: any = {};
    if (!values.name || values.name.trim() === '') {
      errors.name = { type: 'required', message: 'Tag name is required' };
    }
    if (Object.keys(errors).length > 0) {
      return { values: {}, errors };
    }
    return { values, errors: {} };
  },
}));

const makeTag = (overrides: Partial<Tag> = {}): Tag => ({
  id: 't1',
  userId: 'u1',
  name: 'Groceries',
  color: '#ef4444',
  icon: 'shopping-cart',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('TagForm', () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form fields (Tag Name, Colour picker, Icon picker)', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByText('Tag Name')).toBeInTheDocument();
    expect(screen.getByText('Colour')).toBeInTheDocument();
    expect(screen.getByText('Icon')).toBeInTheDocument();
  });

  it('shows validation error when name is empty on submit', async () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Create Tag'));

    await waitFor(() => {
      expect(screen.getByText('Tag name is required')).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('populates form with existing tag data when editing', () => {
    const tag = makeTag({ name: 'Urgent', color: '#3b82f6', icon: 'star' });

    render(<TagForm tag={tag} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByDisplayValue('Urgent')).toBeInTheDocument();
  });

  it('calls onSubmit with form data on valid submission', async () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    const nameInput = screen.getByLabelText('Tag Name');
    fireEvent.change(nameInput, { target: { value: 'My Tag' } });
    fireEvent.click(screen.getByText('Create Tag'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Tag' }),
        expect.anything(),
      );
    });
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses "chart-bar" as default icon for new tags', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    const iconInput = screen.getByTestId('icon-picker-input');
    expect(iconInput).toHaveValue('chart-bar');
  });

  it('shows "Create Tag" button for new tags', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByText('Create Tag')).toBeInTheDocument();
  });

  it('shows "Update Tag" button when editing', () => {
    const tag = makeTag();

    render(<TagForm tag={tag} onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByText('Update Tag')).toBeInTheDocument();
  });

  it('renders empty name field in create mode', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    const nameInput = screen.getByLabelText('Tag Name');
    expect(nameInput).toHaveValue('');
  });

  it('renders colour swatches with palette options', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    expect(screen.getByTitle('Red')).toBeInTheDocument();
    expect(screen.getByTitle('Blue')).toBeInTheDocument();
    expect(screen.getByTitle('Green')).toBeInTheDocument();
    expect(screen.getByTitle('No colour')).toBeInTheDocument();
  });

  it('selects colour when swatch is clicked', () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    const redSwatch = screen.getByTitle('Red');
    fireEvent.click(redSwatch);

    expect(redSwatch.className).toContain('ring-2');
  });

  it('pre-fills colour when editing a tag with colour', () => {
    const tag = makeTag({ color: '#ef4444' });

    render(<TagForm tag={tag} onSubmit={onSubmit} onCancel={onCancel} />);

    const redSwatch = screen.getByTitle('Red');
    expect(redSwatch.className).toContain('ring-2');
  });

  it('does not call onSubmit when validation fails', async () => {
    render(<TagForm onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Create Tag'));

    await waitFor(() => {
      expect(screen.getByText('Tag name is required')).toBeInTheDocument();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
