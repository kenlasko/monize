import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ResetPasswordModal } from './ResetPasswordModal';

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: {
    success: (...args: any[]) => mockToastSuccess(...args),
    error: (...args: any[]) => mockToastError(...args),
  },
}));

describe('ResetPasswordModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('shows instruction about password change on next login', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('The user will be required to change their password on next login.')).toBeInTheDocument();
  });

  it('shows Temporary Password label', () => {
    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.getByText('Temporary Password')).toBeInTheDocument();
  });

  it('shows Copy button initially', () => {
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

  it('copies password to clipboard and shows Copied', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    });

    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="SecretPass!" userName="Jane" onClose={onClose} />
    );

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('SecretPass!');
    });
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Password copied to clipboard');
  });

  it('shows error toast when clipboard write fails', async () => {
    const mockWriteText = vi.fn().mockRejectedValue(new Error('Not allowed'));
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    });

    render(
      <ResetPasswordModal isOpen={true} temporaryPassword="abc123" userName="Jane" onClose={onClose} />
    );

    fireEvent.click(screen.getByText('Copy'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to copy to clipboard');
    });
  });

  it('does not render when isOpen is false', () => {
    render(
      <ResetPasswordModal isOpen={false} temporaryPassword="abc123" userName="John Doe" onClose={onClose} />
    );
    expect(screen.queryByText('Password Reset Successful')).not.toBeInTheDocument();
  });
});
