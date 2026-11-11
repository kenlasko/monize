import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { buttonClassName } from './Button';

describe('UnsavedChangesDialog', () => {
  const defaultProps = {
    isOpen: true,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders nothing when not open', () => {
    const { container } = render(
      <UnsavedChangesDialog {...defaultProps} isOpen={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title and message when open', () => {
    render(<UnsavedChangesDialog {...defaultProps} />);
    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(screen.getByText('You have unsaved changes. What would you like to do?')).toBeInTheDocument();
  });

  it('renders Save, Discard, and Cancel buttons', () => {
    render(<UnsavedChangesDialog {...defaultProps} />);
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Discard')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('saves with the shared primary Button, not hand-written colour classes', () => {
    render(<UnsavedChangesDialog {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain(
      buttonClassName('primary'),
    );
  });

  it('calls onSave when Save is clicked', () => {
    const onSave = vi.fn();
    render(<UnsavedChangesDialog {...defaultProps} onSave={onSave} />);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('enables Save and shows no reason by default', () => {
    render(<UnsavedChangesDialog {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByTestId('unsaved-changes-save-blocked')).not.toBeInTheDocument();
  });

  it('disables Save and says why when given a reason it cannot be saved', () => {
    const onSave = vi.fn();
    render(
      <UnsavedChangesDialog {...defaultProps} onSave={onSave} saveDisabledReason="Pick at least one." />,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('unsaved-changes-save-blocked')).toHaveTextContent('Pick at least one.');
    // Discard and Cancel still work.
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('calls onDiscard when Discard is clicked', () => {
    const onDiscard = vi.fn();
    render(<UnsavedChangesDialog {...defaultProps} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByText('Discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<UnsavedChangesDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
