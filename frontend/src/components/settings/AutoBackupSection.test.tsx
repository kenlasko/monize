import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { AutoBackupSection } from './AutoBackupSection';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    getAutoBackupSettings: vi.fn(),
    updateAutoBackupSettings: vi.fn(),
    validateFolder: vi.fn(),
    browseFolders: vi.fn(),
    runAutoBackup: vi.fn(),
    exportBackup: vi.fn(),
    restoreBackup: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { backupApi } from '@/lib/backupApi';
import toast from 'react-hot-toast';

const defaultSettings = {
  userId: '123',
  enabled: false,
  folderPath: '',
  frequency: 'daily' as const,
  backupTime: '02:00',
  retentionDaily: 7,
  retentionWeekly: 4,
  retentionMonthly: 6,
  lastBackupAt: null,
  lastBackupStatus: null,
  lastBackupError: null,
  nextBackupAt: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

async function renderAutoBackupSection() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AutoBackupSection />);
  });
  return result!;
}

describe('AutoBackupSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultSettings,
    );
  });

  it('renders the auto-backup section with default settings', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Automatic Backup')).toBeInTheDocument();
    expect(screen.getByText('Enable automatic backups')).toBeInTheDocument();
    expect(screen.getByLabelText('Backup Folder')).toHaveValue('');
    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('daily');
  });

  it('shows loading state initially', () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    );

    render(<AutoBackupSection />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error toast on load failure', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Load failed'),
    );

    await renderAutoBackupSection();

    expect(toast.error).toHaveBeenCalledWith('Failed to load auto-backup settings');
  });

  it('populates form with existing settings', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      enabled: true,
      folderPath: '/backups',
      frequency: 'weekly',
      retentionDaily: 14,
      retentionWeekly: 8,
      retentionMonthly: 12,
    });

    await renderAutoBackupSection();

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
    expect(screen.getByLabelText('Backup Folder')).toHaveValue('/backups');
    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('weekly');
    expect(screen.getByLabelText('Daily backups')).toHaveValue(14);
    expect(screen.getByLabelText('Weekly backups')).toHaveValue(8);
    expect(screen.getByLabelText('Monthly backups')).toHaveValue(12);
  });

  it('enables save button when form is dirty', async () => {
    await renderAutoBackupSection();

    const saveButton = screen.getByText('Save Settings');
    expect(saveButton).toBeDisabled();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    expect(saveButton).not.toBeDisabled();
  });

  it('validates folder path', async () => {
    (backupApi.validateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true,
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Validate'));
    });

    await waitFor(() => {
      expect(backupApi.validateFolder).toHaveBeenCalledWith('/backups');
      expect(toast.success).toHaveBeenCalledWith('Folder is valid and writable');
    });
  });

  it('shows validation error for invalid folder', async () => {
    (backupApi.validateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: false,
      error: 'Folder does not exist',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/invalid' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Validate'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Folder does not exist');
    });
  });

  it('saves settings on save button click', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Settings'));
    });

    await waitFor(() => {
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: '/backups',
          frequency: 'daily',
          retentionDaily: 7,
          retentionWeekly: 4,
          retentionMonthly: 6,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith('Auto-backup settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Save failed'),
    );

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Folder'), {
        target: { value: '/backups' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Settings'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save settings');
    });
  });

  it('shows Run Backup Now button when folder is configured', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });

    await renderAutoBackupSection();

    expect(screen.getByText('Run Backup Now')).toBeInTheDocument();
  });

  it('does not show Run Backup Now button when no folder configured', async () => {
    await renderAutoBackupSection();

    expect(screen.queryByText('Run Backup Now')).not.toBeInTheDocument();
  });

  it('runs manual backup', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
    });
    (backupApi.runAutoBackup as ReturnType<typeof vi.fn>).mockResolvedValue({
      message: 'Backup completed',
      filename: 'monize-backup-2026-04-02T10-00-00.json.gz',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Run Backup Now'));
    });

    await waitFor(() => {
      expect(backupApi.runAutoBackup).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith(
        'Backup created: monize-backup-2026-04-02T10-00-00.json.gz',
      );
    });
  });

  it('shows status section when last backup exists', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
      lastBackupAt: '2026-04-01T10:00:00Z',
      lastBackupStatus: 'success',
      nextBackupAt: '2026-04-02T10:00:00Z',
    });

    await renderAutoBackupSection();

    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Last backup')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Next backup')).toBeInTheDocument();
  });

  it('shows error details when last backup failed', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      folderPath: '/backups',
      lastBackupAt: '2026-04-01T10:00:00Z',
      lastBackupStatus: 'failed',
      lastBackupError: 'Folder not writable',
    });

    await renderAutoBackupSection();

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Folder not writable')).toBeInTheDocument();
  });

  it('changes frequency selection', async () => {
    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Frequency'), {
        target: { value: 'every6hours' },
      });
    });

    expect(screen.getByLabelText('Backup Frequency')).toHaveValue('every6hours');
  });

  it('changes retention values', async () => {
    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Daily backups'), {
        target: { value: '14' },
      });
    });

    expect(screen.getByLabelText('Daily backups')).toHaveValue(14);
  });

  it('disables validate button when folder path is empty', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Validate')).toBeDisabled();
  });

  it('renders backup time field with default value', async () => {
    await renderAutoBackupSection();

    const timeInput = screen.getByLabelText('Backup Time (UTC)');
    expect(timeInput).toBeInTheDocument();
    expect(timeInput).toHaveValue('02:00');
  });

  it('populates backup time from settings', async () => {
    (backupApi.getAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      backupTime: '14:30',
    });

    await renderAutoBackupSection();

    expect(screen.getByLabelText('Backup Time (UTC)')).toHaveValue('14:30');
  });

  it('includes backupTime when saving settings', async () => {
    (backupApi.updateAutoBackupSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultSettings,
      backupTime: '08:00',
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Backup Time (UTC)'), {
        target: { value: '08:00' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Save Settings'));
    });

    await waitFor(() => {
      expect(backupApi.updateAutoBackupSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          backupTime: '08:00',
        }),
      );
    });
  });

  it('shows Browse button for folder selection', async () => {
    await renderAutoBackupSection();

    expect(screen.getByText('Browse...')).toBeInTheDocument();
  });

  it('opens folder browser and displays directories', async () => {
    (backupApi.browseFolders as ReturnType<typeof vi.fn>).mockResolvedValue({
      current: '/',
      directories: ['backups', 'data', 'tmp'],
    });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse...'));
    });

    await waitFor(() => {
      expect(backupApi.browseFolders).toHaveBeenCalledWith('/');
      expect(screen.getByText('backups')).toBeInTheDocument();
      expect(screen.getByText('data')).toBeInTheDocument();
      expect(screen.getByText('tmp')).toBeInTheDocument();
    });
  });

  it('navigates into a subdirectory when clicked', async () => {
    (backupApi.browseFolders as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        current: '/',
        directories: ['backups', 'data'],
      })
      .mockResolvedValueOnce({
        current: '/backups',
        directories: ['daily', 'weekly'],
      });

    await renderAutoBackupSection();

    await act(async () => {
      fireEvent.click(screen.getByText('Browse...'));
    });

    await waitFor(() => {
      expect(screen.getByText('backups')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('backups'));
    });

    await waitFor(() => {
      expect(backupApi.browseFolders).toHaveBeenCalledWith('/backups');
      expect(screen.getByText('daily')).toBeInTheDocument();
    });
  });
});
