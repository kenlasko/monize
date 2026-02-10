import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ResetPasswordModal } from './ResetPasswordModal';

describe('ResetPasswordModal', () => {
  const onClose = vi.fn();

  it('renders dialog title and user name', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('Password Reset Successful')).toBeInTheDocument();
    expect(screen.getByText(/John Doe/)).toBeInTheDocument();
  });

  it('displays the temporary password', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="TempPass42!" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('TempPass42!')).toBeInTheDocument();
  });

  it('shows warning that password will not be shown again', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('This password will not be shown again.')).toBeInTheDocument();
  });

  it('shows Copy button', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('calls onClose when Close button is clicked', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});
