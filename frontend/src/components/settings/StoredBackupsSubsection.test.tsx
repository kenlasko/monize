import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { StoredBackupsSubsection } from './StoredBackupsSubsection';
import { useAuthStore } from '@/store/authStore';
import type { BackupOffsiteSettingsView, StoredBackup } from '@/lib/backupApi';
import type { User } from '@/types/auth';

vi.mock('@/lib/backupApi', () => ({
  backupApi: {
    listStoredBackups: vi.fn(),
    downloadStoredBackup: vi.fn(),
    getOffsiteSettings: vi.fn(),
    updateOffsiteSettings: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      preferences: {
        timezone: 'UTC',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '24h',
      },
    }),
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

import { backupApi } from '@/lib/backupApi';
import toast from 'react-hot-toast';

const daily: StoredBackup = {
  filename: 'monize-backup-daily-2026-04-15.json.gz',
  modifiedAt: '2026-04-15T02:00:00.000Z',
  size: 2048,
  encrypted: false,
};

const adminUser = { id: 'u1', role: 'admin', authProvider: 'local' } as User;
const regularUser = { id: 'u2', role: 'user', authProvider: 'local' } as User;

const offView: BackupOffsiteSettingsView = {
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
};

const ownView: BackupOffsiteSettingsView = {
  ...offView,
  s3Mode: 'own',
  s3Bucket: 'my-bucket',
  s3Region: 'us-east-1',
  s3AccessKeyIdSet: true,
  s3SecretAccessKeySet: true,
};

const listMock = backupApi.listStoredBackups as ReturnType<typeof vi.fn>;
const downloadMock = backupApi.downloadStoredBackup as ReturnType<typeof vi.fn>;
const getOffsiteMock = backupApi.getOffsiteSettings as ReturnType<typeof vi.fn>;
const updateOffsiteMock = backupApi.updateOffsiteSettings as ReturnType<
  typeof vi.fn
>;

async function renderSubsection(onRestore = vi.fn()) {
  await act(async () => {
    render(<StoredBackupsSubsection onRestore={onRestore} />);
  });
  return onRestore;
}

async function expand() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('stored-backups-summary'));
  });
}

/**
 * Whether a disclosure is folded, read off the element that does the folding.
 *
 * jsdom applies no user-agent stylesheet to `<details>`, so its children stay
 * in the document whatever `open` says -- asserting the table has gone would
 * pass in a browser and fail here for a reason that has nothing to do with
 * this component. `open` is the mechanism, so `open` is what is asserted.
 */
function isFolded(testId: string): boolean {
  const details = screen.getByTestId(testId).closest('details');
  return details !== null && !details.open;
}

describe('StoredBackupsSubsection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: regularUser, isAuthenticated: true });
    HTMLAnchorElement.prototype.click = vi.fn();
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    global.URL.revokeObjectURL = vi.fn();
    // The folded destinations form fetches on mount whenever the sub-section
    // renders; default it to an "off" destination so tests not about it are
    // unaffected by its controls.
    getOffsiteMock.mockResolvedValue(offView);
  });

  it('renders nothing when no schedule is armed and nothing is stored', async () => {
    listMock.mockResolvedValue({ enabled: false, backups: [] });

    const { container } = await act(async () =>
      render(<StoredBackupsSubsection onRestore={vi.fn()} />),
    );

    // A deployment that runs no automatic backups has nothing to say here, so
    // the section is not part of the page at all -- and the folded destinations
    // form, which lives inside it, never mounts.
    expect(container.textContent).toBe('');
    expect(getOffsiteMock).not.toHaveBeenCalled();
  });

  it('still renders when the schedule was turned off but artifacts remain', async () => {
    listMock.mockResolvedValue({ enabled: false, backups: [daily] });

    await renderSubsection();

    // Those files are recoverable data and this is the only screen that can
    // hand them back.
    expect(screen.getByText('Automatic Backups')).toBeInTheDocument();
  });

  it('starts folded, and lists the artifacts once expanded', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();

    expect(screen.getByText('Automatic Backups')).toBeInTheDocument();
    expect(isFolded('stored-backups-summary')).toBe(true);

    await expand();

    expect(isFolded('stored-backups-summary')).toBe(false);
    expect(screen.getByText(daily.filename)).toBeInTheDocument();
    // The file's own modification time, in the reader's timezone and format.
    expect(screen.getByText('2026-04-15 02:00')).toBeInTheDocument();
    expect(screen.getByText('2.0 kB')).toBeInTheDocument();
  });

  it('holds the list in a fixed-height scroll window', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    await expand();

    // A deployment can hold months of daily artifacts; the window keeps a long
    // list from dominating the Settings page.
    const scroller = screen.getByRole('table').parentElement;
    expect(scroller!.className).toContain('max-h-96');
    expect(scroller!.className).toContain('overflow-y-auto');
  });

  it('wraps each row into a grid card with the actions stacked on the right', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    await expand();

    const row = screen
      .getAllByRole('row')
      .find((r) => r.className.includes('grid-cols-[minmax(0,1fr)_auto]'));
    expect(row).toBeDefined();
    expect(row!.className).toContain('sm:table-row');

    const cells = screen.getAllByRole('cell');
    const filenameCell = cells.find((c) =>
      c.textContent?.startsWith(daily.filename),
    );
    expect(filenameCell!.className).toContain('col-span-2');
    expect(filenameCell!.className).toContain('row-start-1');

    const actionsCell = cells.find((c) => c.className.includes('col-start-2'));
    expect(actionsCell!.className).toContain('row-start-3');
    const sizeCell = cells.find((c) => c.textContent?.includes('2.0 kB'));
    expect(sizeCell!.className).toContain('col-start-1');
    expect(sizeCell!.className).toContain('row-start-3');
    const buttons = actionsCell!.querySelector('div');
    expect(buttons!.className).toContain('flex-col');
    expect(buttons!.className).toContain('sm:flex-row');

    for (const caption of ['Date Modified', 'Size']) {
      expect(screen.getAllByText(caption)).toHaveLength(2);
    }
  });

  it('points an administrator at the page that holds the schedule', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });

    await renderSubsection();
    await expand();

    const link = screen.getByRole('link', { name: 'Admin → Backups' });
    expect(link).toHaveAttribute('href', '/admin/backups');
  });

  it('withholds the schedule link from a reader who cannot open it', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    await expand();

    expect(
      screen.queryByRole('link', { name: 'Admin → Backups' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Automatic backup settings are in/),
    ).not.toBeInTheDocument();
  });

  it('says so when the server is holding nothing yet', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [] });

    await renderSubsection();
    await expand();

    expect(
      screen.getByText(
        'This server is not holding any automatic backups for you yet.',
      ),
    ).toBeInTheDocument();
  });

  it('reports a failed listing instead of rendering it as an empty folder', async () => {
    listMock.mockRejectedValue(new Error('boom'));

    await renderSubsection();
    await expand();

    expect(
      screen.getByText('Failed to load the backups stored on the server'),
    ).toBeInTheDocument();

    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    await act(async () => {
      fireEvent.click(screen.getByText('Try Again'));
    });
    expect(screen.getByText(daily.filename)).toBeInTheDocument();
  });

  it('downloads an artifact under the name the server gave it', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    downloadMock.mockResolvedValue(new File(['bytes'], daily.filename));

    await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });

    expect(downloadMock).toHaveBeenCalledWith(daily.filename);
    expect(
      (HTMLAnchorElement.prototype.click as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1);
  });

  it('hands a restore to the caller rather than restoring here', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    const file = new File(['bytes'], daily.filename);
    downloadMock.mockResolvedValue(file);

    const onRestore = await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(onRestore).toHaveBeenCalledWith(file);
  });

  it('toasts and calls nobody back when the download fails', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });
    downloadMock.mockRejectedValue(new Error('gone'));

    const onRestore = await renderSubsection();
    await expand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to download the backup');
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('re-reads the folder on each expand', async () => {
    listMock.mockResolvedValue({ enabled: true, backups: [daily] });

    await renderSubsection();
    expect(listMock).toHaveBeenCalledTimes(1);

    await expand();
    expect(listMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.click(screen.getByTestId('stored-backups-summary'));
    });
    expect(isFolded('stored-backups-summary')).toBe(true);
    // Folding is not a read.
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  describe("each artifact's off-site copy status", () => {
    function withOffsite(offsite: StoredBackup['offsite']): StoredBackup {
      return { ...daily, offsite };
    }

    it('draws one icon per destination that has a status, coloured by group', async () => {
      listMock.mockResolvedValue({
        enabled: true,
        backups: [
          withOffsite({ s3: 'uploaded', email: 'uploaded' }),
        ],
      });

      await renderSubsection();
      await expand();

      // Success reads green, and both destinations name themselves and their
      // state in the accessible title.
      const s3 = screen.getByRole('img', { name: 'S3: Copied' });
      const email = screen.getByRole('img', { name: 'Email: Copied' });
      expect(s3.className).toContain('text-green-600');
      expect(email.className).toContain('text-green-600');
    });

    it('colours each status group and never guesses an unknown one', async () => {
      listMock.mockResolvedValue({
        enabled: true,
        backups: [
          { ...daily, filename: 'a.mzbe', offsite: { s3: 'failed' } },
          { ...daily, filename: 'b.mzbe', offsite: { s3: 'conflict' } },
          {
            ...daily,
            filename: 'c.mzbe',
            offsite: { s3: 'skipped-too-large', email: 'skipped-unencrypted' },
          },
          { ...daily, filename: 'd.mzbe', offsite: { s3: 'uploading' } },
          {
            ...daily,
            filename: 'e.mzbe',
            offsite: {
              s3: 'quarantined' as NonNullable<
                StoredBackup['offsite']
              >['s3'],
            },
          },
        ],
      });

      await renderSubsection();
      await expand();

      // failed/conflict -> danger, skipped-* -> warning, in-flight -> neutral.
      expect(
        screen.getByRole('img', { name: 'S3: Failed' }).className,
      ).toContain('text-red-600');
      expect(
        screen.getByRole('img', { name: 'S3: Conflict' }).className,
      ).toContain('text-red-600');
      expect(
        screen.getByRole('img', { name: 'S3: Skipped: too large' }).className,
      ).toContain('text-amber-600');
      expect(
        screen.getByRole('img', { name: 'Email: Skipped: not encrypted' })
          .className,
      ).toContain('text-amber-600');
      expect(
        screen.getByRole('img', { name: 'S3: Sending' }).className,
      ).toContain('text-gray-400');
      // An unknown status names itself and draws neutral, never a success or a
      // failure it does not know to be.
      const unknown = screen.getByRole('img', { name: 'S3: quarantined' });
      expect(unknown.className).toContain('text-gray-400');
    });

    it('draws no icon for a destination with no status, and none at all with no off-site rows', async () => {
      listMock.mockResolvedValue({
        enabled: true,
        backups: [
          // One destination present, the other absent: only the S3 icon draws.
          { ...daily, filename: 'one.mzbe', offsite: { s3: 'uploaded' } },
          // No off-site rows at all: no icons.
          daily,
          // An off-site object with no destination status: still no icons.
          { ...daily, filename: 'blank.mzbe', offsite: {} },
        ],
      });

      await renderSubsection();
      await expand();

      expect(screen.getByRole('img', { name: 'S3: Copied' })).toBeInTheDocument();
      // Only one artifact reported any status, and it reported only S3.
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(
        screen.queryByRole('img', { name: /^Email:/ }),
      ).not.toBeInTheDocument();
    });
  });

  describe('the folded off-site destinations form', () => {
    it('folds the destinations block by default', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });

      await renderSubsection();
      await expand();

      expect(screen.getByText('Off-site destinations')).toBeInTheDocument();
      expect(isFolded('offsite-destinations-summary')).toBe(true);

      await act(async () => {
        fireEvent.click(
          screen.getByTestId('offsite-destinations-summary'),
        );
      });
      expect(isFolded('offsite-destinations-summary')).toBe(false);
    });

    it('reveals the own-bucket fields and never renders a stored secret', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);

      await renderSubsection();

      expect(screen.getByLabelText('Bucket')).toHaveValue('my-bucket');
      const accessKey = screen.getByLabelText('Access key ID');
      const secret = screen.getByLabelText('Secret access key');
      // The server reports only that a credential is stored, so both boxes are
      // empty and say so; a value here would be a secret the API never returns.
      expect(accessKey).toHaveValue('');
      expect(secret).toHaveValue('');
      expect(accessKey).toHaveAttribute('placeholder', '•••• stored');
      expect(secret).toHaveAttribute('placeholder', '•••• stored');
      expect(accessKey).toHaveAttribute('type', 'password');
    });

    it('hides the own-bucket fields while the mode is not `own`', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(offView);

      await renderSubsection();

      expect(screen.queryByLabelText('Bucket')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'My own bucket' }));
      });
      expect(screen.getByLabelText('Bucket')).toBeInTheDocument();
    });

    it('sends only the fields that changed, and no blank credential', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockResolvedValue({ ...ownView, s3Bucket: 'other-bucket' });

      await renderSubsection();

      expect(
        screen.getByRole('button', { name: 'Save Destinations' }),
      ).toBeDisabled();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Bucket'), {
          target: { value: 'other-bucket' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });

      // The region, the mode and both credentials were untouched: resending them
      // would re-write columns nobody edited, and a blank credential string would
      // read as a field the user cleared.
      expect(updateOffsiteMock).toHaveBeenCalledWith({ s3Bucket: 'other-bucket' });
    });

    it('sends a credential the user actually typed, then empties the box', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockResolvedValue(ownView);

      await renderSubsection();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Secret access key'), {
          target: { value: 'typed-secret' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });

      expect(updateOffsiteMock).toHaveBeenCalledWith({
        s3SecretAccessKey: 'typed-secret',
      });
      // Adopting the server's answer empties the box again, so the next save
      // cannot resend what was already stored.
      expect(screen.getByLabelText('Secret access key')).toHaveValue('');
    });

    it('shows the server refusal beside the form rather than only in a toast', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockRejectedValue(new Error('400'));

      await renderSubsection();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Bucket'), {
          target: { value: 'other-bucket' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });
      await act(async () => {});

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed to save your off-site backup destinations',
      );
    });

    it('forgets stored credentials only through the flag, and only once confirmed', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockResolvedValue({
        ...ownView,
        s3AccessKeyIdSet: false,
        s3SecretAccessKeySet: false,
      });

      await renderSubsection();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Remove Stored Credentials' }),
        );
      });

      // Asking is part of it: a blank box means "leave it alone", so forgetting
      // a working destination's credentials is never a side effect of a save.
      expect(updateOffsiteMock).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(
          within(screen.getByRole('dialog')).getByRole('button', {
            name: 'Cancel',
          }),
        );
      });
      expect(updateOffsiteMock).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Remove Stored Credentials' }),
        );
      });
      const dialog = screen.getByRole('dialog');
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole('button', {
            name: 'Remove Stored Credentials',
          }),
        );
      });

      expect(updateOffsiteMock).toHaveBeenCalledWith({ clearS3Credentials: true });
      expect(
        screen.queryByRole('button', { name: 'Remove Stored Credentials' }),
      ).not.toBeInTheDocument();
    });

    it('carries every own-bucket field the user edited into one payload', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockResolvedValue(ownView);

      await renderSubsection();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Region'), {
          target: { value: 'eu-central-1' },
        });
        fireEvent.change(screen.getByLabelText('Key prefix'), {
          target: { value: 'backups/' },
        });
        fireEvent.change(screen.getByLabelText('Endpoint'), {
          target: { value: 'https://s3.example.com' },
        });
        fireEvent.click(screen.getByLabelText('Use path-style addressing'));
        fireEvent.change(screen.getByLabelText('Access key ID'), {
          target: { value: 'AKIAEXAMPLE' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });

      expect(updateOffsiteMock).toHaveBeenCalledWith({
        s3Region: 'eu-central-1',
        s3Prefix: 'backups/',
        s3Endpoint: 'https://s3.example.com',
        s3ForcePathStyle: true,
        s3AccessKeyId: 'AKIAEXAMPLE',
      });
    });

    it('clears a field the user emptied rather than leaving the stored value', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(ownView);
      updateOffsiteMock.mockResolvedValue({ ...ownView, s3Region: null });

      await renderSubsection();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Region'), {
          target: { value: '  ' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });

      expect(updateOffsiteMock).toHaveBeenCalledWith({ s3Region: null });
    });

    it('turns email on and sends the address with it', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue(offView);
      updateOffsiteMock.mockResolvedValue({
        ...offView,
        emailEnabled: true,
        emailTo: 'me@example.com',
      });

      await renderSubsection();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('switch', {
            name: 'Email me a copy of each completed automatic backup',
          }),
        );
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Send copies to'), {
          target: { value: 'me@example.com' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save Destinations' }));
      });

      expect(updateOffsiteMock).toHaveBeenCalledWith({
        emailEnabled: true,
        emailTo: 'me@example.com',
      });
    });

    it('says why a bucket of your own cannot be configured with no encryption key', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue({ ...offView, encryptionConfigured: false });

      await renderSubsection();

      expect(
        screen.getByText(/This server has no encryption key set/),
      ).toBeInTheDocument();
    });

    it("disables the deployment's bucket when this server has none", async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockResolvedValue({
        ...offView,
        deploymentS3Available: false,
      });

      await renderSubsection();

      // Disabled rather than hidden: a control that vanishes says nothing about
      // why, and the hint beside it names what would have to change.
      expect(
        screen.getByRole('button', { name: "This server's bucket" }),
      ).toBeDisabled();
      expect(
        screen.getByText(/This server has no off-site bucket of its own/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'My own bucket' }),
      ).toBeEnabled();
    });

    it('reports a failed destinations read instead of an empty form', async () => {
      listMock.mockResolvedValue({ enabled: true, backups: [] });
      getOffsiteMock.mockRejectedValue(new Error('boom'));

      await renderSubsection();

      expect(
        screen.getByText('Failed to load your off-site backup destinations'),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Off' }),
      ).not.toBeInTheDocument();
    });
  });
});
