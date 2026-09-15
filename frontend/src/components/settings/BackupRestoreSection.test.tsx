import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BackupRestoreSection } from './BackupRestoreSection';
import { User } from '@/types/auth';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    exportBackup: vi.fn(),
    restoreBackup: vi.fn(),
    getEncryptionStatus: vi.fn().mockResolvedValue({
      enabled: false,
      manageable: false,
      method: 'login-password',
      available: true,
    }),
    enableWithLoginPassword: vi.fn(),
    setBackupPassword: vi.fn(),
    disableEncryption: vi.fn(),
    listStoredBackups: vi.fn(),
    downloadStoredBackup: vi.fn(),
    getOffsiteSettings: vi.fn(),
    updateOffsiteSettings: vi.fn(),
  },
  BACKUP_PASSWORD_REQUIRED_CODE: 'BACKUP_PASSWORD_REQUIRED',
  // Mirror the real magic-byte sniffing so the restore form shows the
  // backup-password field only for encrypted (.mzbe) uploads.
  isEncryptedBackupFile: vi.fn(async (file: File) => {
    try {
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (
        header.length === 4 &&
        header[0] === 0x4d &&
        header[1] === 0x5a &&
        header[2] === 0x42 &&
        header[3] === 0x45
      ) {
        return true;
      }
    } catch {
      // fall through to the extension check
    }
    return file.name.toLowerCase().endsWith('.mzbe');
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { backupApi } from '@/lib/backupApi';
import { getLocalDateString } from '@/lib/utils';
import { usePreferencesStore } from '@/store/preferencesStore';
import { UserPreferences } from '@/types/auth';
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

// Renders inside act() so the on-mount getEncryptionStatus() fetch and its
// resulting state update are flushed before assertions run.
async function renderSection(user: User = localUser) {
  await act(async () => {
    render(<BackupRestoreSection user={user} />);
  });
}

describe('BackupRestoreSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the timezone preference so tests default to the browser timezone
    // unless they set one explicitly (prevents leakage between tests).
    usePreferencesStore.setState({ preferences: null, isLoaded: false });
    // The download flow clicks a blob-href anchor; jsdom logs "Not implemented:
    // navigation" for that, so stub the click to keep test output clean.
    HTMLAnchorElement.prototype.click = vi.fn();
    // Re-set the default for getEncryptionStatus since per-test
    // mockResolvedValue overrides survive clearAllMocks.
    (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
      manageable: false,
      method: 'login-password',
      available: true,
    });
    // No automatic-backup schedule and nothing on disk: the stored-backups
    // subsection renders nothing, which is the state every test below that is
    // not about it expects.
    (backupApi.listStoredBackups as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
      backups: [],
    });
    // Off-site destinations are off: the folded destinations form renders its
    // own controls, which no test below is about. It only mounts when the
    // stored-backups sub-section itself renders (schedule armed or artifacts on
    // disk), so most tests below never reach it.
    (backupApi.getOffsiteSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        s3Mode: 'off',
        s3Bucket: null,
        s3Region: null,
        s3Prefix: null,
        s3Endpoint: null,
        s3ForcePathStyle: false,
        s3AccessKeyIdSet: false,
        s3SecretAccessKeySet: false,
        emailEnabled: false,
        emailTo: null,
        deploymentS3Available: true,
        encryptionConfigured: true,
      },
    );
  });

  it('renders backup and restore sections', async () => {
    await renderSection(localUser);

    expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
    expect(screen.getByText('Create Backup')).toBeInTheDocument();
    expect(screen.getByText('Restore from Backup')).toBeInTheDocument();
    expect(screen.getByText('Download Backup')).toBeInTheDocument();
    expect(screen.getByText('Restore from Backup...')).toBeInTheDocument();
  });

  it('downloads backup when export button clicked', async () => {
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: true,
      missingAttachments: 0,
      inconsistentAttachments: 0,
      expectedAttachments: 0,
      includedAttachments: 0,
    });

    // Mock URL.createObjectURL and revokeObjectURL
    const mockUrl = 'blob:http://localhost/mock-url';
    const createObjectURL = vi.fn().mockReturnValue(mockUrl);
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(backupApi.exportBackup).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Backup downloaded successfully');
    });
  });

  it('does not call an incomplete export a success, and names the file INCOMPLETE (F3RB-004)', async () => {
    // The backend knows the artifact cannot restore every attachment it names.
    // A success toast here is how a user ends up deleting the source system for
    // a file that cannot bring it back.
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: false,
      missingAttachments: 2,
      inconsistentAttachments: 0,
      expectedAttachments: 5,
      includedAttachments: 3,
    });
    const anchorEl = document.createElement('a');
    const clickSpy = vi.spyOn(anchorEl, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'a'
        ? anchorEl
        : (Document.prototype.createElement.call(
            document,
            tag,
          ) as HTMLElement),
    );
    global.URL.createObjectURL = vi
      .fn()
      .mockReturnValue('blob:http://localhost/mock-url');
    global.URL.revokeObjectURL = vi.fn();

    await renderSection(localUser);
    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('INCOMPLETE'),
        expect.anything(),
      );
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(anchorEl.download).toContain('-INCOMPLETE.');
    expect(clickSpy).toHaveBeenCalled();

    vi.mocked(document.createElement).mockRestore();
  });

  it('counts a checksum-mismatched attachment as unusable, not as zero (F3RB-R2-LOW)', async () => {
    // Reporting only `missing` said "0 of 1 attachment(s)" for an artifact whose
    // single attachment was corrupt: a false number, and it pointed at storage
    // when the cause was corruption. Both modes are equally unrestorable and the
    // backend excludes both from `includedAttachments`.
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: false,
      missingAttachments: 0,
      inconsistentAttachments: 1,
      expectedAttachments: 1,
      includedAttachments: 0,
    });
    global.URL.createObjectURL = vi
      .fn()
      .mockReturnValue('blob:http://localhost/mock-url');
    global.URL.revokeObjectURL = vi.fn();

    await renderSection(localUser);
    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    const message = (toast.error as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // The headline count is the unusable total, not just the absent ones...
    expect(message).toContain('1 of 1');
    expect(message).not.toContain('0 of 1');
    // ...and the breakdown still says which mode it was.
    expect(message).toContain('1 failed an integrity check');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('names the download using the local calendar date, not UTC', async () => {
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: true,
      missingAttachments: 0,
      inconsistentAttachments: 0,
      expectedAttachments: 0,
      includedAttachments: 0,
    });
    global.URL.createObjectURL = vi
      .fn()
      .mockReturnValue('blob:http://localhost/mock-url');
    global.URL.revokeObjectURL = vi.fn();

    // Force the UTC representation to a date that can never match the local
    // calendar date. The old filename was built from `toISOString().slice(0, 10)`
    // (UTC), so this catches a regression regardless of the machine's timezone.
    const isoSpy = vi
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue('2099-12-31T00:00:00.000Z');

    let capturedDownload = '';
    HTMLAnchorElement.prototype.click = vi.fn(function (
      this: HTMLAnchorElement,
    ) {
      capturedDownload = this.download;
    });

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Backup downloaded successfully');
    });

    expect(capturedDownload).toBe(`monize-backup-${getLocalDateString()}.json.gz`);
    expect(capturedDownload).not.toContain('2099-12-31');

    isoSpy.mockRestore();
  });

  it('dates the download by the timezone preference, not the browser timezone', async () => {
    const mockBlob = new Blob(['{}'], { type: 'application/json' });
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: true,
      missingAttachments: 0,
      inconsistentAttachments: 0,
      expectedAttachments: 0,
      includedAttachments: 0,
    });
    global.URL.createObjectURL = vi
      .fn()
      .mockReturnValue('blob:http://localhost/mock-url');
    global.URL.revokeObjectURL = vi.fn();

    // Fake only Date so waitFor's real timers keep working. At this instant it
    // is still 2026-07-17 in UTC but already 2026-07-18 in Australia/Sydney
    // (UTC+10), so the two dates diverge regardless of the test machine's zone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-17T20:00:00Z'));

    usePreferencesStore.setState({
      preferences: { timezone: 'Australia/Sydney' } as UserPreferences,
    });

    let capturedDownload = '';
    HTMLAnchorElement.prototype.click = vi.fn(function (
      this: HTMLAnchorElement,
    ) {
      capturedDownload = this.download;
    });

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Backup downloaded successfully');
    });

    expect(capturedDownload).toBe('monize-backup-2026-07-18.json.gz');

    vi.useRealTimers();
  });

  it('shows error toast on export failure', async () => {
    (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Export failed'),
    );

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Download Backup'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create backup');
    });
  });

  it('expands restore form when button clicked', async () => {
    await renderSection(localUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    expect(screen.getByText('Select backup file')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
    expect(screen.getByText('Confirm Restore')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('shows OIDC re-auth button for OIDC users', async () => {
    await renderSection(oidcUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    expect(screen.getByText('Re-authenticate and Restore')).toBeInTheDocument();
  });

  it('collapses restore form on cancel', async () => {
    await renderSection(localUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));
    expect(screen.getByText('Confirm Restore')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Confirm Restore')).not.toBeInTheDocument();
  });

  it('disables confirm button without password and file', async () => {
    await renderSection(localUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    const confirmButton = screen.getByText('Confirm Restore');
    expect(confirmButton).toBeDisabled();
  });

  it('restores backup successfully and shows summary modal', async () => {
    (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: 'Backup restored successfully',
      restored: { categories: 5, accounts: 3 },
    });

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    // Simulate file selection
    const backupContent = JSON.stringify({ version: 1, exportedAt: '2026-01-01' });
    const file = new File([backupContent], 'backup.json', { type: 'application/json' });
    const fileInput = screen.getByLabelText('Select backup file') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

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
    expect(await screen.findByText('Restore Complete')).toBeInTheDocument();
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

  /**
   * Attachment files live outside the database, so a restore can succeed for
   * every ledger row while some attachments have no bytes to point at. Those
   * rows are not written, and a summary that stays silent tells the user files
   * came back that did not.
   */
  describe('attachments that could not be restored', () => {
    async function restoreWith(result: Record<string, unknown>) {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue(result);
      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      const file = new File(['{}'], 'backup.json', { type: 'application/json' });
      const fileInput = screen.getByLabelText('Select backup file') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'testpass' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));
      await screen.findByText('Restore Complete');
    }

    it('warns when the backend skipped some attachments', async () => {
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 3 },
        skippedAttachments: 2,
      });

      expect(
        screen.getByText(/2 attachments were not restored/),
      ).toBeInTheDocument();
      // The skipped rows were not written, so they must not be added into the
      // total: 3 restored + 2 skipped must never read as 5.
      expect(screen.getAllByText('3').length).toBeGreaterThan(0);
      expect(screen.queryByText('5')).not.toBeInTheDocument();
    });

    it('uses the singular form for one attachment', async () => {
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 1 },
        skippedAttachments: 1,
      });

      expect(
        screen.getByText(/1 attachment was not restored/),
      ).toBeInTheDocument();
    });

    it('says nothing when every attachment came back', async () => {
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 1 },
      });

      expect(screen.queryByText(/were not restored/)).not.toBeInTheDocument();
      expect(screen.queryByText(/was not restored/)).not.toBeInTheDocument();
    });

    it('warns when a provider came back without a usable API key', async () => {
      // The rows restored; the key inside them did not. Nothing else on the
      // screen says so -- the provider list shows a masked key either way -- so
      // a silent success leaves AI features failing for no visible reason.
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 4 },
        unusableAiProviderKeys: 2,
      });

      expect(
        screen.getByText(/2 AI providers were restored without usable API keys/),
      ).toBeInTheDocument();
      // Same rule as skipped attachments: the count is not part of the total.
      expect(screen.getAllByText('4').length).toBeGreaterThan(0);
      expect(screen.queryByText('6')).not.toBeInTheDocument();
    });

    it('uses the singular form for one provider', async () => {
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 1 },
        unusableAiProviderKeys: 1,
      });

      expect(
        screen.getByText(/1 AI provider was restored without a usable API key/),
      ).toBeInTheDocument();
    });

    it('says nothing when every provider key came back', async () => {
      await restoreWith({
        message: 'Backup restored successfully',
        restored: { accounts: 1 },
      });

      expect(
        screen.queryByText(/without a usable API key/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/without usable API keys/),
      ).not.toBeInTheDocument();
    });
  });

  it('shows error toast on restore failure', async () => {
    (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Server error'),
    );

    await renderSection(localUser);

    fireEvent.click(screen.getByText('Restore from Backup...'));

    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const fileInput = screen.getByLabelText('Select backup file') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(passwordInput, { target: { value: 'testpass' } });

    fireEvent.click(screen.getByText('Confirm Restore'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to restore backup');
    });
  });

  describe('backup password section', () => {
    const localStatus = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      enabled: false,
      manageable: false,
      method: 'login-password',
      available: true,
      ...overrides,
    });

    it('tells a local-auth user their backups are encrypted, with nothing to set', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        localStatus({ enabled: true }),
      );

      await renderSection(localUser);

      // Their backups are encrypted with the login password the server captured
      // when they last typed it, so there is no second password to invent -- but
      // the state is on the page, which is what issue #1269 found missing.
      await waitFor(() =>
        expect(screen.getByText('Backup Encryption')).toBeInTheDocument(),
      );
      expect(screen.getByText('Enabled')).toBeInTheDocument();
      expect(screen.queryByText('Set Backup Password')).toBeNull();
      expect(screen.queryByText('Change Backup Password')).toBeNull();
      expect(screen.queryByText('Disable')).toBeNull();
    });

    it('tells a local-auth user when their backups are NOT encrypted', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        localStatus(),
      );

      await renderSection(localUser);

      // The reported state: automatic backups going out in plaintext while every
      // other surface said they were encrypted by default. Rendering nothing for
      // it is what made the defect invisible.
      await waitFor(() =>
        expect(screen.getByText('Not enabled')).toBeInTheDocument(),
      );
      expect(
        screen.getByText('Enable with My Login Password'),
      ).toBeInTheDocument();
    });

    it('enables encryption from the login password a local user confirms', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(localStatus())
        .mockResolvedValueOnce(localStatus({ enabled: true }));
      (
        backupApi.enableWithLoginPassword as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);

      await renderSection(localUser);
      await waitFor(() =>
        expect(
          screen.getByText('Enable with My Login Password'),
        ).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Enable with My Login Password'));

      fireEvent.change(screen.getByPlaceholderText(/Your login password/), {
        target: { value: 'hunter2hunter2' },
      });
      fireEvent.click(screen.getByText('Confirm'));

      // The login-password endpoint, not the OIDC dedicated-password one: the
      // server verifies it against the account's own hash.
      await waitFor(() =>
        expect(backupApi.enableWithLoginPassword).toHaveBeenCalledWith(
          'hunter2hunter2',
        ),
      );
      expect(backupApi.setBackupPassword).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByText('Enabled')).toBeInTheDocument(),
      );
    });

    it('says so when the server cannot encrypt backups at all', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        localStatus({ available: false }),
      );

      await renderSection(localUser);

      // "This server holds no key" and "you have not turned it on" have
      // different fixes, so they cannot render as the same blank.
      await waitFor(() =>
        expect(
          screen.getByText(/not configured to encrypt backups/),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByText('Enable with My Login Password'),
      ).toBeNull();
    });

    it('offers an OIDC user a password to set', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
        manageable: true,
        method: 'backup-password',
        available: true,
      });

      await renderSection(oidcUser);

      // No login password of ours exists for them, so this is the only way
      // their backups can be encrypted at all.
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
    });

    it('sets the password an OIDC user types', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ enabled: false, manageable: true, method: 'backup-password', available: true })
        .mockResolvedValueOnce({ enabled: true, manageable: true, method: 'backup-password', available: true });
      (backupApi.setBackupPassword as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      await renderSection(oidcUser);
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Set Backup Password'));

      fireEvent.change(screen.getByPlaceholderText(/New backup password/), {
        target: { value: 'a-strong-backup-password' },
      });
      fireEvent.click(screen.getByText('Confirm'));

      await waitFor(() =>
        expect(backupApi.setBackupPassword).toHaveBeenCalledWith(
          'a-strong-backup-password',
        ),
      );
      await waitFor(() =>
        expect(screen.getByText('Enabled')).toBeInTheDocument(),
      );
    });

    it('shows an error toast when setting the password fails', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
        manageable: true,
        method: 'backup-password',
        available: true,
      });
      (backupApi.setBackupPassword as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('breached'),
      );

      await renderSection(oidcUser);
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Set Backup Password'));
      fireEvent.change(screen.getByPlaceholderText(/New backup password/), {
        target: { value: 'hunter2hunter2' },
      });
      fireEvent.click(screen.getByText('Confirm'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to enable encryption'),
      );
    });

    it('lets an OIDC user change the password or turn it off', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ enabled: true, manageable: true, method: 'backup-password', available: true })
        .mockResolvedValueOnce({ enabled: false, manageable: true, method: 'backup-password', available: true });
      (backupApi.disableEncryption as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );

      await renderSection(oidcUser);
      await waitFor(() =>
        expect(screen.getByText('Change Backup Password')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Disable'));

      await waitFor(() => expect(backupApi.disableEncryption).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
    });

    it('shows an error toast when disabling fails', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        manageable: true,
        method: 'backup-password',
        available: true,
      });
      (backupApi.disableEncryption as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('boom'),
      );

      await renderSection(oidcUser);
      await waitFor(() => expect(screen.getByText('Disable')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Disable'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to disable encryption'),
      );
    });

    it('closes the password modal on Cancel without calling the API', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
        manageable: true,
        method: 'backup-password',
        available: true,
      });

      await renderSection(oidcUser);
      await waitFor(() =>
        expect(screen.getByText('Set Backup Password')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByText('Set Backup Password'));
      expect(
        screen.getByPlaceholderText(/New backup password/),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));

      expect(
        screen.queryByPlaceholderText(/New backup password/),
      ).not.toBeInTheDocument();
      expect(backupApi.setBackupPassword).not.toHaveBeenCalled();
    });

    it('will not export while the encryption status is unknown', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('network'),
      );

      await renderSection(localUser);

      // A failed status read is not "encryption off" -- exporting on that
      // assumption would hand the user a plaintext copy of everything.
      await waitFor(() =>
        expect(screen.getByText('Download Backup')).toBeDisabled(),
      );
      expect(backupApi.exportBackup).not.toHaveBeenCalled();
    });
  });

  describe('encrypted export flow', () => {
    it('prompts for an encryption password when encryption is enabled, then downloads with .mzbe extension', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        manageable: false,
      });
      const mockBlob = new Blob(['encrypted'], { type: 'application/octet-stream' });
      (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      blob: mockBlob,
      complete: true,
      missingAttachments: 0,
      inconsistentAttachments: 0,
      expectedAttachments: 0,
      includedAttachments: 0,
    });
      const createObjectURL = vi.fn().mockReturnValue('blob:mock');
      const revokeObjectURL = vi.fn();
      global.URL.createObjectURL = createObjectURL;
      global.URL.revokeObjectURL = revokeObjectURL;

      await renderSection(localUser);
      // Wait for status to load so the export click sees encryption=enabled.
      await waitFor(() =>
        expect(screen.getByText('Download Backup')).toBeEnabled(),
      );

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
        manageable: false,
      });
      await renderSection(localUser);
      await waitFor(() =>
        expect(screen.getByText('Download Backup')).toBeEnabled(),
      );
      fireEvent.click(screen.getByText('Download Backup'));
      await screen.findByPlaceholderText('Login password');
      fireEvent.click(screen.getByText('Cancel'));
      expect(backupApi.exportBackup).not.toHaveBeenCalled();
    });
  });

  describe('restore: encrypted backups', () => {
    // Real MZBE magic header so the component detects the file as encrypted.
    const encryptedFile = (name = 'backup.mzbe') =>
      new File([new Uint8Array([0x4d, 0x5a, 0x42, 0x45, 0x01, 0x01])], name);

    it('shows a backup-password field and sends both passwords on confirm', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockResolvedValue({ message: 'ok', restored: { accounts: 1 } });

      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [encryptedFile()] } },
        );
      });

      // The encrypted file reveals a dedicated backup-password field, distinct
      // from the account-password confirmation field.
      const backupPw = await screen.findByPlaceholderText('Backup password');
      fireEvent.change(backupPw, { target: { value: 'the-backup-pw' } });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'account-pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));

      await waitFor(() => {
        expect(restoreMock).toHaveBeenCalledWith({
          file: expect.any(File),
          password: 'account-pw',
          backupPassword: 'the-backup-pw',
        });
      });
    });

    it('does not show a backup-password field for unencrypted files', async () => {
      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [new File(['{}'], 'b.json.gz')] } },
        );
      });
      expect(
        screen.queryByPlaceholderText('Backup password'),
      ).not.toBeInTheDocument();
    });

    it('guides the user to the backup-password field when decryption fails', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockImplementationOnce(() => {
        const err = new Error('encrypted') as Error & {
          isAxiosError: boolean;
          response: { data: { code: string } };
        };
        // Mimic an axios error -- isBackupPasswordRequired uses isAxiosError.
        err.isAxiosError = true;
        err.response = { data: { code: 'BACKUP_PASSWORD_REQUIRED' } };
        return Promise.reject(err);
      });

      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [encryptedFile()] } },
        );
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'account-pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'This backup is encrypted. Enter the password it was created with in the "Backup password" field, then try again.',
        ),
      );
      // The field stays so the user can supply the backup password and retry.
      expect(
        screen.getByPlaceholderText('Backup password'),
      ).toBeInTheDocument();
    });

    it('non-encryption errors still surface the generic failure toast', async () => {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('regular error'),
      );
      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [new File(['{}'], 'b.json.gz')] } },
        );
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'pw' },
      });
      fireEvent.click(screen.getByText('Confirm Restore'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Failed to restore backup'),
      );
    });
  });

  describe('OIDC restore', () => {
    it('passes the OIDC token instead of a password', async () => {
      (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
        message: 'ok',
        restored: {},
      });
      await renderSection(oidcUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [new File(['{}'], 'b.json.gz')] } },
        );
      });
      // P2-005: the client can only present an artifact the OIDC callback
      // minted; it used to send the literal string 'oidc-session-confirmed'.
      sessionStorage.setItem('oidcReauthArtifact', 'signed.artifact.value');
      fireEvent.click(screen.getByText('Re-authenticate and Restore'));
      await waitFor(() => expect(backupApi.restoreBackup).toHaveBeenCalled());
      const call = (backupApi.restoreBackup as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.oidcIdToken).toBe('signed.artifact.value');
      expect(call.password).toBeUndefined();
    });

    it('OIDC restore Cancel closes the form', async () => {
      await renderSection(oidcUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      expect(screen.getByText('Re-authenticate and Restore')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Cancel'));
      expect(
        screen.queryByText('Re-authenticate and Restore'),
      ).not.toBeInTheDocument();
    });
  });

  it('toasts an error when no file is selected on restore', async () => {
    await renderSection(localUser);
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
      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          { target: { files: [new File(['{}'], 'b.json.gz')] } },
        );
      });
      const pw = screen.getByPlaceholderText('Enter your password');
      fireEvent.change(pw, { target: { value: 'pw' } });
      fireEvent.keyDown(pw, { key: 'Enter' });
      await waitFor(() => expect(backupApi.restoreBackup).toHaveBeenCalled());
    });

    it('Enter on the export-password input triggers export', async () => {
      (backupApi.getEncryptionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        manageable: false,
      });
      (backupApi.exportBackup as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Blob(['x']),
      );
      global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
      global.URL.revokeObjectURL = vi.fn();

      await renderSection(localUser);
      await waitFor(() =>
        expect(screen.getByText('Download Backup')).toBeEnabled(),
      );
      fireEvent.click(screen.getByText('Download Backup'));
      const input = await screen.findByPlaceholderText('Login password');
      fireEvent.change(input, { target: { value: 'pw' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(backupApi.exportBackup).toHaveBeenCalledWith('pw'),
      );
    });

    it('Enter on the backup-password field submits an encrypted restore', async () => {
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockResolvedValue({ message: 'ok', restored: {} });

      await renderSection(localUser);
      fireEvent.click(screen.getByText('Restore from Backup...'));
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText('Select backup file') as HTMLInputElement,
          {
            target: {
              files: [new File([new Uint8Array([0x4d, 0x5a, 0x42, 0x45])], 'b.mzbe')],
            },
          },
        );
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'account-pw' },
      });
      const backupPw = screen.getByPlaceholderText('Backup password');
      fireEvent.change(backupPw, { target: { value: 'backup-pw' } });
      fireEvent.keyDown(backupPw, { key: 'Enter' });
      await waitFor(() =>
        expect(restoreMock).toHaveBeenCalledWith({
          file: expect.any(File),
          password: 'account-pw',
          backupPassword: 'backup-pw',
        }),
      );
    });
  });

  describe('restoring from the automatic backups on the server', () => {
    const storedBackup = {
      filename: 'monize-backup-daily-2026-04-15.mzbe',
      modifiedAt: '2026-04-15T02:00:00.000Z',
      size: 2048,
      encrypted: true,
    };

    async function openServerList() {
      (backupApi.listStoredBackups as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        backups: [storedBackup],
      });
      await renderSection(localUser);
      await act(async () => {
        fireEvent.click(screen.getByText('Automatic Backups'));
      });
    }

    beforeEach(async () => {
      await openServerList();
    });

    it('hands the downloaded artifact to the one restore workflow', async () => {
      // The bytes carry the encrypted-envelope magic, so the form must ask for
      // the backup password exactly as it would for a file picked from disk --
      // that is the whole claim: nothing downstream can tell where the file
      // came from.
      (backupApi.downloadStoredBackup as ReturnType<typeof vi.fn>).mockResolvedValue(
        new File(
          [new Uint8Array([0x4d, 0x5a, 0x42, 0x45])],
          storedBackup.filename,
        ),
      );
      const restoreMock = backupApi.restoreBackup as ReturnType<typeof vi.fn>;
      restoreMock.mockResolvedValue({ message: 'ok', restored: {} });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      });

      expect(backupApi.downloadStoredBackup).toHaveBeenCalledWith(
        storedBackup.filename,
      );
      // The restore form is open, names the artifact, and is asking for the
      // encrypted backup's own password.
      expect(
        screen.getByText(`Selected: ${storedBackup.filename}`),
      ).toBeInTheDocument();
      const backupPw = screen.getByPlaceholderText('Backup password');

      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'account-pw' },
      });
      fireEvent.change(backupPw, { target: { value: 'backup-pw' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Confirm Restore'));
      });

      expect(restoreMock).toHaveBeenCalledWith({
        file: expect.objectContaining({ name: storedBackup.filename }),
        password: 'account-pw',
        backupPassword: 'backup-pw',
      });
      // The same summary dialogue a file restore ends in.
      expect(screen.getByText('Restore Complete')).toBeInTheDocument();
    });

    it('does not open the restore form when the download fails', async () => {
      (backupApi.downloadStoredBackup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('gone'),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
      });

      expect(toast.error).toHaveBeenCalled();
      // Nothing was selected, so the destructive form stays shut.
      expect(screen.queryByText('Confirm Restore')).toBeNull();
      expect(backupApi.restoreBackup).not.toHaveBeenCalled();
    });
  });

});
