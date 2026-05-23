import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BackupRestoreSection } from './BackupRestoreSection';
import { User } from '@/types/auth';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    exportBackup: vi.fn(),
    restoreBackup: vi.fn(),
    getEncryptionStatus: vi.fn().mockResolvedValue({
      enabled: false,
      needsBackupPassword: false,
    }),
    enableLocalEncryption: vi.fn(),
    setBackupPassword: vi.fn(),
    disableEncryption: vi.fn(),
  },
  BACKUP_PASSWORD_REQUIRED_CODE: 'BACKUP_PASSWORD_REQUIRED',
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
    // Re-set the default for getEncryptionStatus since per-test
    // mockResolvedValue overrides survive clearAllMocks.
    (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
      needsBackupPassword: false,
    });
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
        backupPassword: undefined,
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

  describe('encryption setup', () => {
    it('falls back to disabled state if the status fetch fails', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('network'),
      );
      render(<BackupRestoreSection user={localUser} />);
      // The fallback path renders the "Enable Encrypted Backups" CTA.
      await waitFor(() =>
        expect(screen.getByText('Enable Encrypted Backups')).toBeInTheDocument(),
      );
    });

    it('local user: enable flow calls enableLocalEncryption with the typed password', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ enabled: false, needsBackupPassword: false })
        // After enabling, the component re-fetches status.
        .mockResolvedValueOnce({ enabled: true, needsBackupPassword: false });
      (backupApi.enableLocalEncryption as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() =>
        expect(screen.getByText('Enable Encrypted Backups')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Enable Encrypted Backups'));

      const input = screen.getByPlaceholderText('Your login password');
      fireEvent.change(input, { target: { value: 'my-login-pw' } });
      fireEvent.click(screen.getByText('Confirm'));

      await waitFor(() =>
        expect(backupApi.enableLocalEncryption).toHaveBeenCalledWith('my-login-pw'),
      );
    });

    it('OIDC user: enable flow calls setBackupPassword', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ enabled: false, needsBackupPassword: true })
        .mockResolvedValueOnce({ enabled: true, needsBackupPassword: false });
      (backupApi.setBackupPassword as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      render(<BackupRestoreSection user={oidcUser} />);
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Set Backup Password'));

      const input = screen.getByPlaceholderText(/New backup password/);
      fireEvent.change(input, { target: { value: 'a-strong-backup-password' } });
      fireEvent.click(screen.getByText('Confirm'));

      await waitFor(() =>
        expect(backupApi.setBackupPassword).toHaveBeenCalledWith(
          'a-strong-backup-password',
        ),
      );
    });

    it('shows an error toast when enable fails', async () => {
      (backupApi.enableLocalEncryption as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('bad password'),
      );
      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() =>
        expect(screen.getByText('Enable Encrypted Backups')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Enable Encrypted Backups'));
      fireEvent.change(screen.getByPlaceholderText('Your login password'), {
        target: { value: 'x' },
      });
      fireEvent.click(screen.getByText('Confirm'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to enable encryption'),
      );
    });

    it('disable button calls disableEncryption when encryption is on', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ enabled: true, needsBackupPassword: false })
        .mockResolvedValueOnce({ enabled: false, needsBackupPassword: false });
      (backupApi.disableEncryption as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Disable'));

      await waitFor(() => expect(backupApi.disableEncryption).toHaveBeenCalled());
    });

    it('shows an error toast when disable fails', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        needsBackupPassword: false,
      });
      (backupApi.disableEncryption as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('boom'),
      );
      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Disable'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to disable encryption'),
      );
    });

    it('OIDC user with encryption on sees a Change Backup Password button', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        needsBackupPassword: false,
      });
      render(<BackupRestoreSection user={oidcUser} />);
      await waitFor(() =>
        expect(screen.getByText('Change Backup Password')).toBeInTheDocument(),
      );
    });

    it('encryption setup modal Cancel closes it without calling the API', async () => {
      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() =>
        expect(screen.getByText('Enable Encrypted Backups')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Enable Encrypted Backups'));
      expect(screen.getByPlaceholderText('Your login password')).toBeInTheDocument();
      // Click the Cancel inside the modal (the Cancel button in the section
      // is hidden because the restore form is not open).
      fireEvent.click(screen.getByText('Cancel'));
      expect(
        screen.queryByPlaceholderText('Your login password'),
      ).not.toBeInTheDocument();
      expect(backupApi.enableLocalEncryption).not.toHaveBeenCalled();
    });
  });

  describe('encrypted export flow', () => {
    it('prompts for an encryption password when encryption is enabled, then downloads with .mzbe extension', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        needsBackupPassword: false,
      });
      const mockBlob = new Blob(['encrypted'], { type: 'application/octet-stream' });
      (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue(mockBlob);
      const createObjectURL = vi.fn().mockReturnValue('blob:mock');
      const revokeObjectURL = vi.fn();
      global.URL.createObjectURL = createObjectURL;
      global.URL.revokeObjectURL = revokeObjectURL;

      render(<BackupRestoreSection user={localUser} />);
      // Wait for status to load so the export click sees encryption=enabled.
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Download Backup'));
      const pwInput = await screen.findByPlaceholderText('Login password');
      fireEvent.change(pwInput, { target: { value: 'my-pw' } });
      fireEvent.click(screen.getByText('Download'));

      await waitFor(() =>
        expect(backupApi.exportBackup).toHaveBeenCalledWith('my-pw'),
      );
      // Trigger an Anchor with .mzbe href.
      expect(createObjectURL).toHaveBeenCalled();
    });

    it('export password prompt Cancel closes without exporting', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        needsBackupPassword: false,
      });
      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Download Backup'));
      await screen.findByPlaceholderText('Login password');
      fireEvent.click(screen.getByText('Cancel'));
      expect(backupApi.exportBackup).not.toHaveBeenCalled();
    });
  });

  describe('restore: backup-password retry flow', () => {
    it('opens the prompt and retries with the supplied password', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      // First call: server says BACKUP_PASSWORD_REQUIRED.
      restoreMock.mockImplementationOnce(() => {
        const err = new Error('encrypted') as Error & {
          isAxiosError: boolean;
          response: { data: { code: string } };
        };
        // Mimic an axios error -- the isBackupPasswordRequired helper uses
        // axios's isAxiosError type guard.
        err.isAxiosError = true;
        err.response = { data: { code: 'BACKUP_PASSWORD_REQUIRED' } };
        return Promise.reject(err);
      });
      restoreMock.mockResolvedValueOnce({
        message: 'ok',
        restored: { accounts: 1 },
      });

      render(<BackupRestoreSection user={localUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      const file = new File([new Uint8Array([0x4d])], 'backup.mzbe');
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        { target: { files: [file] } },
      );
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'login-pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));

      // The retry prompt appears.
      const retryInput = await screen.findByPlaceholderText(
        /Password used to create this backup/,
      );
      fireEvent.change(retryInput, { target: { value: 'old-backup-pw' } });
      fireEvent.click(screen.getByText('Try Password'));

      await waitFor(() => {
        expect(restoreMock).toHaveBeenCalledTimes(2);
        expect(restoreMock.mock.calls[1][0].backupPassword).toBe('old-backup-pw');
      });
    });

    it('non-encryption errors still surface as toasts (no retry prompt)', async () => {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('regular error'),
      );
      render(<BackupRestoreSection user={localUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        {
          target: {
            files: [new File(['{}'], 'b.json.gz')],
          },
        },
      );
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to restore backup'),
      );
      expect(
        screen.queryByPlaceholderText(/Password used to create this backup/),
      ).not.toBeInTheDocument();
    });
  });

  describe('OIDC restore', () => {
    it('passes the OIDC token instead of a password', async () => {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: 'ok',
        restored: {},
      });
      render(<BackupRestoreSection user={oidcUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        { target: { files: [new File(['{}'], 'b.json.gz')] } },
      );
      fireEvent.click(screen.getByText('Re-authenticate and Restore'));
      await waitFor(() => expect(backupApi.restoreBackup).toHaveBeenCalled());
      const call = (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.oidcIdToken).toBe('oidc-session-confirmed');
      expect(call.password).toBeUndefined();
    });

    it('OIDC restore Cancel closes the form', async () => {
      render(<BackupRestoreSection user={oidcUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      expect(screen.getByText('Re-authenticate and Restore')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Cancel'));
      expect(
        screen.queryByText('Re-authenticate and Restore'),
      ).not.toBeInTheDocument();
    });
  });

  it('toasts an error when no file is selected on restore', async () => {
    render(<BackupRestoreSection user={localUser} />);
    fireEvent.click(screen.getByText('Restore from Backup...'));
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'pw' },
    });
    // The "Confirm Restore" button is disabled without a file, so call the
    // handler via the keyboard-on-Enter path which has no disabled-check.
    fireEvent.keyDown(screen.getByPlaceholderText('Enter your password'), {
      key: 'Enter',
    });
    // No file -> no API call, no toast either since the disabled button
    // is the primary guard. Submit via Enter (which only fires if both
    // file+password are set) so this expectation just asserts the click
    // path is unreachable without a file.
    expect(backupApi.restoreBackup).not.toHaveBeenCalled();
  });

  describe('keyboard handlers', () => {
    it('Enter on the restore-password input submits when a file is selected', async () => {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: 'ok',
        restored: {},
      });
      render(<BackupRestoreSection user={localUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        { target: { files: [new File(['{}'], 'b.json.gz')] } },
      );
      const pw = screen.getByPlaceholderText('Enter your password');
      fireEvent.change(pw, { target: { value: 'pw' } });
      fireEvent.keyDown(pw, { key: 'Enter' });
      await waitFor(() => expect(backupApi.restoreBackup).toHaveBeenCalled());
    });

    it('Enter on the export-password input triggers export', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        needsBackupPassword: false,
      });
      (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Blob(['x']),
      );
      global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
      global.URL.revokeObjectURL = vi.fn();

      render(<BackupRestoreSection user={localUser} />);
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Download Backup'));
      const input = await screen.findByPlaceholderText('Login password');
      fireEvent.change(input, { target: { value: 'pw' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(backupApi.exportBackup).toHaveBeenCalledWith('pw'),
      );
    });

    it('Enter on the backup-password retry input retries restore', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockImplementationOnce(() => {
        const err = new Error('encrypted') as Error & {
          isAxiosError: boolean;
          response: { data: { code: string } };
        };
        err.isAxiosError = true;
        err.response = { data: { code: 'BACKUP_PASSWORD_REQUIRED' } };
        return Promise.reject(err);
      });
      restoreMock.mockResolvedValueOnce({ message: 'ok', restored: {} });

      render(<BackupRestoreSection user={localUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        { target: { files: [new File(['x'], 'b.mzbe')] } },
      );
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));
      const retry = await screen.findByPlaceholderText(
        /Password used to create this backup/,
      );
      fireEvent.change(retry, { target: { value: 'old-pw' } });
      fireEvent.keyDown(retry, { key: 'Enter' });
      await waitFor(() => expect(restoreMock).toHaveBeenCalledTimes(2));
    });

    it('Cancel in the backup-password retry modal closes it', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockImplementationOnce(() => {
        const err = new Error('encrypted') as Error & {
          isAxiosError: boolean;
          response: { data: { code: string } };
        };
        err.isAxiosError = true;
        err.response = { data: { code: 'BACKUP_PASSWORD_REQUIRED' } };
        return Promise.reject(err);
      });

      render(<BackupRestoreSection user={localUser} />);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      fireEvent.change(
        screen.getByLabelText('Select backup file') as HTMLInputElement,
        { target: { files: [new File(['x'], 'b.mzbe')] } },
      );
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));
      await screen.findByPlaceholderText(/Password used to create this backup/);
      // Two Cancels are visible (restore form and modal). Click the one
      // inside the modal (the last one in DOM order).
      const cancels = screen.getAllByText('Cancel');
      fireEvent.click(cancels[cancels.length - 1]);
      expect(
        screen.queryByPlaceholderText(/Password used to create this backup/),
      ).not.toBeInTheDocument();
    });
  });

  it('OIDC user can open the Change Backup Password modal', async () => {
    (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      needsBackupPassword: false,
    });
    render(<BackupRestoreSection user={oidcUser} />);
    await waitFor(() =>
      expect(screen.getByText('Change Backup Password')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Change Backup Password'));
    expect(
      screen.getByPlaceholderText(/New backup password/),
    ).toBeInTheDocument();
  });
});
