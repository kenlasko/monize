import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkSelectionBanner } from './BulkSelectionBanner';

// Mock Button to render a regular button
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

describe('BulkSelectionBanner', () => {
  const defaultProps = {
    selectionCount: 5,
    isAllOnPageSelected: false,
    selectAllMatching: false,
    totalMatching: 100,
    onSelectAllMatching: vi.fn(),
    onClearSelection: vi.fn(),
    onBulkUpdate: vi.fn(),
  };

  it('returns null when selectionCount is 0', () => {
    const { container } = render(
      <BulkSelectionBanner {...defaultProps} selectionCount={0} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders selection count text', () => {
    render(<BulkSelectionBanner {...defaultProps} selectionCount={5} />);
    expect(screen.getByText('5 transactions selected')).toBeInTheDocument();
  });

  it('shows singular text for 1 selection', () => {
    render(<BulkSelectionBanner {...defaultProps} selectionCount={1} />);
    expect(screen.getByText('1 transaction selected')).toBeInTheDocument();
  });

  it('shows select all matching link when all on page selected', () => {
    render(
      <BulkSelectionBanner
        {...defaultProps}
        isAllOnPageSelected={true}
        selectAllMatching={false}
        totalMatching={100}
        selectionCount={10}
      />
    );
    expect(screen.getByText('Select all 100 matching transactions')).toBeInTheDocument();
  });

  it('does not show select all link when already selecting all', () => {
    render(
      <BulkSelectionBanner
        {...defaultProps}
        isAllOnPageSelected={true}
        selectAllMatching={true}
        totalMatching={100}
        selectionCount={10}
      />
    );
    expect(screen.queryByText(/Select all \d+ matching/)).not.toBeInTheDocument();
  });

  it('calls onSelectAllMatching when link clicked', () => {
    const onSelectAllMatching = vi.fn();
    render(
      <BulkSelectionBanner
        {...defaultProps}
        isAllOnPageSelected={true}
        selectAllMatching={false}
        totalMatching={100}
        selectionCount={10}
        onSelectAllMatching={onSelectAllMatching}
      />
    );
    fireEvent.click(screen.getByText('Select all 100 matching transactions'));
    expect(onSelectAllMatching).toHaveBeenCalled();
  });

  it('calls onClearSelection when Clear clicked', () => {
    const onClearSelection = vi.fn();
    render(
      <BulkSelectionBanner {...defaultProps} onClearSelection={onClearSelection} />
    );
    fireEvent.click(screen.getByText('Clear selection'));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it('calls onBulkUpdate when Bulk Update clicked', () => {
    const onBulkUpdate = vi.fn();
    render(
      <BulkSelectionBanner {...defaultProps} onBulkUpdate={onBulkUpdate} />
    );
    fireEvent.click(screen.getByText('Bulk Update'));
    expect(onBulkUpdate).toHaveBeenCalled();
  });

  it('shows all matching text when selectAllMatching is true', () => {
    render(
      <BulkSelectionBanner
        {...defaultProps}
        selectAllMatching={true}
        selectionCount={10}
      />
    );
    expect(screen.getByText('(all matching transactions)')).toBeInTheDocument();
  });
});
