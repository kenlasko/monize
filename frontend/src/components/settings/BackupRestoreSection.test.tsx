import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BackupRestoreSection } from './BackupRestoreSection';
import { User } from '@/types/auth';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    exportBackup: vi.fn(),
    restoreBackup: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { backupApi } from '@/lib/backupApi';
import toast from 'react-hot-toast';

const localUser: User = {
  id: '123',
  email: 'test@example.com',
  authProvider: 'local',
  hasPassword: true,
  role: 'user',
  isActive: true,
  mustChangePassword: false,
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};

const oidcUser: User = {
  ...localUser,
  authProvider: 'oidc',
  hasPassword: false,
};

describe('BackupRestoreSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders backup and restore sections', () => {
    render(<BackupRestoreSection user={localUser} />);

    expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
    expect(screen.getByText('Create Backup')).toBeInTheDocument();
    expect(screen.getByText('Restore from Backup')).toBeInTheDocument();
    expect(screen.getByText('Download Backup')).toBeInTheDocument();
    expect(screen.getByText('Restore from Backup...')).toBeInTheDocument();
  });

  it('downloads backup when export button clicked', async () => {
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue(mockBlob);

    // Mock URL.createObjectURL and revokeObjectURL
    const mockUrl = 'blob:http://localhost/mock-url';
    const createObjectURL = vi.fn().mockReturnValue(mockUrl);
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(backupApi.exportBackup).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Backup downloaded successfully');
    });
  });

  it('shows error toast on export failure', async () => {
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Export failed'),
    );

    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create backup');
    });
  });

  it('expands restore form when button clicked', () => {
    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    expect(screen.getByText('Select backup file')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
    expect(screen.getByText('Confirm Restore')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows OIDC re-auth button for OIDC users', () => {
    render(<BackupRestoreSection user={oidcUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    expect(screen.getByText('Re-authenticate and Restore')).toBeInTheDocument();
  });

  it('collapses restore form on cancel', () => {
    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));
    expect(screen.getByText('Confirm Restore')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Confirm Restore')).not.toBeInTheDocument();
  });

  it('disables confirm button without password and file', () => {
    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    const confirmButton = screen.getByText('Confirm Restore');
    expect(confirmButton).toBeDisabled();
  });

  it('restores backup successfully and shows summary modal', async () => {
    (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: 'Backup restored successfully',
      restored: { categories: 5, accounts: 3 },
    });

    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    // Simulate file selection
    const backupContent = JSON.stringify({ version: 1, exportedAt: '2026-01-01' });
    const file = new File([backupContent], 'backup.json', { type: 'application/json' });
    const fileInput = screen.getByLabelText('Select backup file') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Enter password
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(passwordInput, { target: { value: 'testpass' } });

    // Click restore
    fireEvent.click(screen.getByText('Confirm Restore'));

    await waitFor(() => {
      expect(backupApi.restoreBackup).toHaveBeenCalledWith({
        password: 'testpass',
        file: expect.any(File),
      });
    });

    // Verify success modal is shown with summary
    expect(screen.getByText('Restore Complete')).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument(); // Total
    expect(screen.getByText('Done')).toBeInTheDocument();

    // Clicking Done closes the modal
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByText('Restore Complete')).not.toBeInTheDocument();
  });

  it('shows error toast on restore failure', async () => {
    (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Server error'),
    );

    render(<BackupRestoreSection user={localUser} />);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const fileInput = screen.getByLabelText('Select backup file') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(passwordInput, { target: { value: 'testpass' } });

    fireEvent.click(screen.getByText('Confirm Restore'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to restore backup');
    });
  });
});
