import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TagList } from './TagList';
import { Tag } from '@/types/tag';

vi.mock('@/components/ui/IconPicker', () => ({
  getIconComponent: (name: string) => <span data-testid={`icon-${name}`}>{name}</span>,
}));

vi.mock('@/components/ui/SortIcon', () => ({
  SortIcon: () => null,
}));

const mockTags: Tag[] = [
  { id: 'tag-1', userId: 'u1', name: 'Groceries', color: '#22c55e', icon: 'shopping-cart', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'tag-2', userId: 'u1', name: 'Urgent', color: null, icon: null, createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
  { id: 'tag-3', userId: 'u1', name: 'Bills', color: '#3b82f6', icon: 'document-text', createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' },
];

const mockTransactionCounts: Record<string, number> = {
  'tag-1': 15,
  'tag-2': 3,
  'tag-3': 42,
};

describe('TagList', () => {
  let onEdit: (tag: Tag) => void;
  let onDelete: (tag: Tag) => void;

  beforeEach(() => {
    onEdit = vi.fn() as (tag: Tag) => void;
    onDelete = vi.fn() as (tag: Tag) => void;
  });

  it('renders tags in a table with Name, Icon, Transactions, Actions columns', () => {
    render(
      <TagList tags={mockTags} onEdit={onEdit} onDelete={onDelete} />,
    );

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Icon')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('shows empty state when no tags', () => {
    render(
      <TagList tags={[]} onEdit={onEdit} onDelete={onDelete} />,
    );

    expect(screen.getByText('No tags found')).toBeInTheDocument();
    expect(screen.getByText('No tags match your current search.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('displays tag name, color swatch, and icon', () => {
    render(
      <TagList tags={mockTags} onEdit={onEdit} onDelete={onDelete} />,
    );

    // Tag names are rendered (sorted: Bills, Groceries, Urgent)
    expect(screen.getByText('Bills')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Urgent')).toBeInTheDocument();

    // Icons rendered for tags that have them
    expect(screen.getByTestId('icon-shopping-cart')).toBeInTheDocument();
    expect(screen.getByTestId('icon-document-text')).toBeInTheDocument();

    // Dash for tags without an icon
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows transaction count for each tag', () => {
    render(
      <TagList
        tags={mockTags}
        transactionCounts={mockTransactionCounts}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('shows 0 transaction count when transactionCounts not provided', () => {
    render(
      <TagList tags={[mockTags[0]]} onEdit={onEdit} onDelete={onDelete} />,
    );

    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('calls onEdit when Edit button clicked', () => {
    render(
      <TagList tags={[mockTags[0]]} onEdit={onEdit} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(mockTags[0]);
  });

  it('calls onDelete when Delete button clicked', () => {
    render(
      <TagList tags={[mockTags[0]]} onEdit={onEdit} onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith(mockTags[0]);
  });

  it('makes tag name clickable when onTagClick is provided', () => {
    const onTagClick = vi.fn();

    render(
      <TagList
        tags={[mockTags[0]]}
        onEdit={onEdit}
        onDelete={onDelete}
        onTagClick={onTagClick}
      />,
    );

    const tagButton = screen.getByText('Groceries');
    expect(tagButton.tagName).toBe('BUTTON');
  });

  it('calls onTagClick with the tag when clicked', () => {
    const onTagClick = vi.fn();

    render(
      <TagList
        tags={[mockTags[0]]}
        onEdit={onEdit}
        onDelete={onDelete}
        onTagClick={onTagClick}
      />,
    );

    fireEvent.click(screen.getByText('Groceries'));
    expect(onTagClick).toHaveBeenCalledWith(mockTags[0]);
  });

  it('renders tag name as span (not button) when onTagClick is not provided', () => {
    render(
      <TagList tags={[mockTags[0]]} onEdit={onEdit} onDelete={onDelete} />,
    );

    const tagName = screen.getByText('Groceries');
    expect(tagName.tagName).toBe('SPAN');
  });

  it('sorts tags by name ascending by default', () => {
    render(
      <TagList tags={mockTags} onEdit={onEdit} onDelete={onDelete} />,
    );

    const rows = screen.getAllByRole('row');
    // First row is the header, data rows follow
    // Sorted: Bills, Groceries, Urgent
    expect(rows[1]).toHaveTextContent('Bills');
    expect(rows[2]).toHaveTextContent('Groceries');
    expect(rows[3]).toHaveTextContent('Urgent');
  });

  it('density toggle cycles through normal, compact, dense', () => {
    render(
      <TagList tags={mockTags} onEdit={onEdit} onDelete={onDelete} />,
    );

    const densityButton = screen.getByTitle('Toggle row density');

    // Default is normal
    expect(densityButton).toHaveTextContent('Normal');

    // Click to cycle to compact
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Compact');

    // Click to cycle to dense
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Dense');

    // Click to cycle back to normal
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Normal');
  });

  it('sort by name toggles direction when clicked again', () => {
    render(
      <TagList tags={mockTags} onEdit={onEdit} onDelete={onDelete} />,
    );

    const nameHeader = screen.getByText('Name');

    // Default sort is name asc: Bills, Groceries, Urgent
    let rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Bills');
    expect(rows[3]).toHaveTextContent('Urgent');

    // Click name header to toggle to desc
    fireEvent.click(nameHeader);
    rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Urgent');
    expect(rows[3]).toHaveTextContent('Bills');

    // Click again to toggle back to asc
    fireEvent.click(nameHeader);
    rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Bills');
    expect(rows[3]).toHaveTextContent('Urgent');
  });

  it('calls onDensityChange when density is controlled', () => {
    const onDensityChange = vi.fn();

    render(
      <TagList
        tags={mockTags}
        onEdit={onEdit}
        onDelete={onDelete}
        density="normal"
        onDensityChange={onDensityChange}
      />,
    );

    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('calls onSort when sort is controlled', () => {
    const onSort = vi.fn();

    render(
      <TagList
        tags={mockTags}
        onEdit={onEdit}
        onDelete={onDelete}
        sortField="name"
        sortDirection="asc"
        onSort={onSort}
      />,
    );

    fireEvent.click(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name');
  });
});
