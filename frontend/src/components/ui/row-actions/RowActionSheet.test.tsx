import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { RowActionSheet } from './RowActionSheet';
import type { RowAction } from './rowAction';

describe('RowActionSheet', () => {
  const baseActions: RowAction[] = [
    { key: 'edit', label: 'Edit', icon: 'edit', tone: 'primary', onClick: vi.fn() },
    { key: 'delete', label: 'Delete', icon: 'delete', tone: 'delete', onClick: vi.fn(), destructive: true },
  ];

  it('renders title and subtitle', () => {
    render(<RowActionSheet isOpen title="Coffee Co" subtitle="2025-06-15" actions={baseActions} onClose={vi.fn()} />);
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
    expect(screen.getByText('2025-06-15')).toBeInTheDocument();
  });

  it('renders one button per visible action', () => {
    render(<RowActionSheet isOpen title="X" actions={baseActions} onClose={vi.fn()} />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('closes then fires the action on click', () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    const actions: RowAction[] = [{ key: 'edit', label: 'Edit', icon: 'edit', tone: 'primary', onClick }];
    render(<RowActionSheet isOpen title="X" actions={actions} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onClose).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  it('omits hidden actions', () => {
    const actions: RowAction[] = [
      { key: 'edit', label: 'Edit', icon: 'edit', tone: 'primary', onClick: vi.fn(), hidden: true },
      { key: 'delete', label: 'Delete', icon: 'delete', tone: 'delete', onClick: vi.fn() },
    ];
    render(<RowActionSheet isOpen title="X" actions={actions} onClose={vi.fn()} />);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('applies destructive styling to destructive actions', () => {
    render(<RowActionSheet isOpen title="X" actions={baseActions} onClose={vi.fn()} />);
    const deleteBtn = screen.getByText('Delete').closest('button');
    expect(deleteBtn?.className).toContain('text-red-600');
  });
});
