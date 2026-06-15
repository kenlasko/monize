import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { RowActions } from './RowActions';
import type { RowAction } from './rowAction';

function makeActions(overrides: Partial<RowAction>[] = []): RowAction[] {
  const base: RowAction[] = [
    { key: 'edit', label: 'Edit', icon: 'edit', tone: 'primary', onClick: vi.fn() },
    { key: 'delete', label: 'Delete', icon: 'delete', tone: 'delete', onClick: vi.fn() },
  ];
  return base.map((a, i) => ({ ...a, ...overrides[i] }));
}

describe('RowActions', () => {
  it('renders text labels in normal density', () => {
    render(<RowActions actions={makeActions()} density="normal" />);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('renders icon-only buttons with accessible labels in compact density', () => {
    render(<RowActions actions={makeActions()} density="compact" />);
    // Label text is not rendered visibly, but exposed via aria-label / title.
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('fires onClick and stops propagation', () => {
    const onClick = vi.fn();
    const rowClick = vi.fn();
    const actions = makeActions([{ onClick }]);
    render(
      <div onClick={rowClick}>
        <RowActions actions={actions} density="normal" />
      </div>,
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(onClick).toHaveBeenCalled();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('omits hidden actions and disables disabled ones', () => {
    const actions = makeActions([{ hidden: true }, { disabled: true }]);
    render(<RowActions actions={actions} density="normal" />);
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeDisabled();
  });

  it('folds surplus actions into an overflow menu past maxInline', () => {
    const actions: RowAction[] = [
      { key: 'a', label: 'Alpha', icon: 'edit', tone: 'primary', onClick: vi.fn() },
      { key: 'b', label: 'Bravo', icon: 'view', tone: 'view', onClick: vi.fn() },
      { key: 'c', label: 'Charlie', icon: 'duplicate', tone: 'neutral', onClick: vi.fn() },
    ];
    render(<RowActions actions={actions} density="normal" maxInline={2} />);
    // First (maxInline - 1) inline, rest behind the kebab.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });
});
