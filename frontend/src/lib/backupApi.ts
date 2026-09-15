import apiClient from './api';
import { clearAllCache } from './apiCache';
import { filenameFromContentDisposition } from './download';
import {
  AutoBackupCapability,
  AutoBackupSettings,
  UpdateAutoBackupSettingsData,
} from '@/types/auth';

// HTTP header values have their leading and trailing whitespace stripped in
// transit (RFC 7230 "optional whitespace"), which silently corrupts passwords
// that begin or end with a space. Base64-encode password header values so every
// byte -- including surrounding whitespace and non-ASCII characters -- survives
// the round trip. The backend decodes them with the matching scheme before any
// credential comparison.
function encodePasswordHeader(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Short-lived authorization for one restore upload.
 *
 * The backend's upload admission runs in front of its body parser -- and so in
 * front of every guard -- which is why this exists: the ticket is minted by an
 * ordinary authenticated request and verified before any memory is reserved for
 * the upload. `header` travels with it so the client cannot drift from the server
 * on the header name.
 */
export interface RestoreUploadTicket {
  ticket: string;
  expiresInSeconds: number;
  header: string;
}

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
  /**
   * Attachments whose metadata was deliberately not restored because their
   * bytes could not be made reachable (absent from the sidecar volume/bucket,
   * failing their recorded checksum, or exported from an instance using a
   * different storage provider). Deliberately outside `restored`, whose values
   * are summed into a row total -- rows that were not written must not be
   * counted as written. Absent when nothing was skipped.
   */
  skippedAttachments?: number;
  /**
   * Restored AI provider rows left without a usable API key. Keys normally
   * travel decrypted and are re-encrypted on arrival, so this covers only a
   * backup written before that (its ciphertext belongs to another instance's
   * `ENCRYPTION_KEY`) or a server with no `ENCRYPTION_KEY` at all. The
   * rows *were* written, so this stays outside `restored` rather than being
   * deducted from it. Absent when none.
   */
  unusableAiProviderKeys?: number;
}

export type SupportBackupSection =
  | 'investments'
  | 'scheduled'
  | 'budgets'
  | 'reports'
  | 'importMappings'
  | 'autoBackup';

export const SUPPORT_BACKUP_SECTIONS: SupportBackupSection[] = [
  'investments',
  'scheduled',
  'budgets',
  'reports',
  'importMappings',
  'autoBackup',
];

export interface SupportBackupInput {
  multiplier: number;
  sections?: SupportBackupSection[];
  accountIds?: string[];
  /** Inclusive yyyy-MM-dd bounds on exported history. */
  dateFrom?: string;
  dateTo?: string;
  /** Price history is excluded by default: a full series can identify a
   *  masked ticker against public market data. */
  includePriceHistory?: boolean;
  /** Required: support backups always leave the machine encrypted. */
  password: string;
}

export interface SupportBackupFile {
  blob: Blob;
  /** Server-chosen filename (Content-Disposition), or null when absent. */
  filename: string | null;
}

export interface SupportBackupPreviewSample {
  table: string;
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

export interface SupportBackupPreview {
  samples: SupportBackupPreviewSample[];
}

/**
 * A random multiplier in [1.1, 9.99] with 5 decimal places, never an integer,
 * matching the backend contract: > 1 (so nothing rounds to zero) and
 * non-integer (so it can't be trivially guessed from a round value). Drawn
 * from the Web Crypto API -- the multiplier is the factor hiding the user's
 * real amounts, so it must not come from a predictable PRNG.
 */
export function randomSupportMultiplier(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const value = 1.1 + (buf[0] / 2 ** 32) * 8.89;
  const rounded = Math.round(value * 1e5) / 1e5;
  return Number.isInteger(rounded) ? rounded + 0.12345 : rounded;
}

/**
 * A random 20-character password from an unambiguous alphabet (no 0/O, 1/l/I),
 * generated with the Web Crypto API. Pre-fills the required encryption
 * password so a support backup never ships with a weak ad-hoc one; the user
 * can still edit or regenerate it.
 */
export function randomSupportPassword(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Axios delivers error bodies as Blobs when the request used
 * `responseType: 'blob'`, which hides the backend's JSON `message` from
 * getErrorMessage. Parse the Blob back into the response data so error
 * toasts show the real reason (demo restriction, validation error).
 */
async function normalizeBlobError(error: unknown): Promise<never> {
  const response = (error as { response?: { data?: unknown } })?.response;
  if (response && response.data instanceof Blob) {
    try {
      response.data = JSON.parse(await response.data.text());
    } catch {
      // Not JSON -- leave the Blob; the caller falls back to its default text.
    }
  }
  throw error;
}

/**
 * One automatic backup the server is holding for this user.
 *
 * `modifiedAt` is the file's own modification time on the server rather than
 * the date inside its name: the name says which recovery point the artifact is
 * and which retention tier keeps it, and a promoted weekly or monthly copy has
 * the two disagree. What the reader is choosing between is files.
 */
export interface StoredBackup {
  filename: string;
  /** ISO-8601 modification time of the file on the server. */
  modifiedAt: string;
  /** Size in bytes. */
  size: number;
  /** True for an encrypted Monize envelope, which needs its password to restore. */
  encrypted: boolean;
  /**
   * The newest off-site copy status for each destination this artifact has
   * off-site rows for. Present only when the artifact has any such row, and a
   * destination key is present only when that destination has a status for it.
   * A destination with no key here has no status for this artifact, and its
   * icon is not drawn. `null` is never a licence to guess a copy happened.
   */
  offsite?: {
    s3?: BackupOffsiteUploadStatus;
    email?: BackupOffsiteUploadStatus;
  };
}

/**
 * The listing, plus whether this user's automatic-backup schedule is armed.
 *
 * The schedule itself is configured on an admin-only endpoint, so a
 * non-administrator cannot read it -- and they are exactly the people who need
 * to know whether anything is backing their data up. The answer travels with
 * the files it explains.
 */
export interface StoredBackupsReport {
  enabled: boolean;
  backups: StoredBackup[];
}

/** Which S3 destination a user's completed backups are copied to. */
export type BackupOffsiteS3Mode = 'off' | 'deployment' | 'own';

/** One configured target kind. A user may hold both at once (3-2-1). */
export type BackupOffsiteDestination = 's3' | 'email';

/**
 * Where one off-machine copy has got to.
 *
 * Mirrors the backend's `BackupOffsiteUploadStatus`. `pending`/`uploading` are
 * in flight, `uploaded` is verified, `failed` is retried by the reaper,
 * `conflict` is a key already holding different bytes, and the two `skipped-*`
 * values are copies deliberately not made.
 */
export type BackupOffsiteUploadStatus =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'conflict'
  | 'skipped-unencrypted'
  | 'skipped-too-large';

/**
 * The caller's off-machine destinations, as the server is willing to describe
 * them.
 *
 * The two stored credentials are **write-only**: the server reports whether
 * each one is set and never its value, so `s3AccessKeyIdSet` /
 * `s3SecretAccessKeySet` are the whole of what a form can know about them.
 * `deploymentS3Available` and `encryptionConfigured` are facts about the
 * deployment rather than the row, and they are here so the surface can say what
 * this server can do before the user fills anything in.
 */
export interface BackupOffsiteSettingsView {
  s3Mode: BackupOffsiteS3Mode;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Prefix: string | null;
  s3Endpoint: string | null;
  s3ForcePathStyle: boolean;
  /** Whether an access key id is stored. Never its value. */
  s3AccessKeyIdSet: boolean;
  /** Whether a secret access key is stored. Never its value. */
  s3SecretAccessKeySet: boolean;
  emailEnabled: boolean;
  emailTo: string | null;
  /** Whether this deployment has a bucket of its own to offer. */
  deploymentS3Available: boolean;
  /** Whether this deployment can store a credential at all (ENCRYPTION_KEY). */
  encryptionConfigured: boolean;
}

/**
 * A change to those destinations. Every field is optional and the server
 * applies only the ones present, so a caller sends what moved and nothing else.
 *
 * A blank credential string means "the form left this alone", never "forget the
 * stored one" -- the value is never rendered back, so the input is empty on
 * every load and an empty-means-clear reading would wipe a working destination
 * on the next unrelated save. `clearS3Credentials` is the instruction to forget.
 */
export interface UpdateBackupOffsiteSettingsData {
  s3Mode?: BackupOffsiteS3Mode;
  s3Bucket?: string | null;
  s3Region?: string | null;
  s3Prefix?: string | null;
  s3Endpoint?: string | null;
  s3ForcePathStyle?: boolean;
  /** Write-only; the server stores it encrypted and never returns it. */
  s3AccessKeyId?: string;
  /** Write-only; the server stores it encrypted and never returns it. */
  s3SecretAccessKey?: string;
  clearS3Credentials?: boolean;
  emailEnabled?: boolean;
  emailTo?: string | null;
}

export interface BackupEncryptionStatus {
  enabled: boolean;
  /**
   * Whether the dedicated backup-password controls belong to this user. False
   * for local-auth accounts: the server keeps a copy of the password they typed
   * at sign-in and encrypts with it, so there is no second password to invent.
   * True for OIDC accounts, which have no password of ours and must set a
   * dedicated backup password (or leave their backups unencrypted).
   */
  manageable: boolean;
  /**
   * Which password opens this user's backups. `login-password` for local
   * accounts, `backup-password` for OIDC ones. Mirrors the backend's
   * `BackupEncryptionStatus`.
   */
  method: 'login-password' | 'backup-password';
  /**
   * Whether the server holds key material to store a password at all. Off means
   * no backup this deployment writes can be encrypted, which is a different
   * thing from this user not having turned it on -- and the difference is the
   * whole point of showing it.
   */
  available: boolean;
}

// Error code surfaced by the backend when an encrypted backup can't be
// decrypted with any password we tried. Frontend uses this to prompt the
// user for the password the backup was originally made with.
export const BACKUP_PASSWORD_REQUIRED_CODE = 'BACKUP_PASSWORD_REQUIRED';

// Encrypted Monize backups begin with the ASCII magic "MZBE" (see the backend
// backup-crypto.util envelope format). Sniffing the first four bytes lets the
// restore UI show a backup-password field only when one is actually needed.
const MZBE_MAGIC = [0x4d, 0x5a, 0x42, 0x45];

export async function isEncryptedBackupFile(file: File): Promise<boolean> {
  try {
    const header = new Uint8Array(
      await file.slice(0, MZBE_MAGIC.length).arrayBuffer(),
    );
    if (
      header.length === MZBE_MAGIC.length &&
      MZBE_MAGIC.every((byte, i) => header[i] === byte)
    ) {
      return true;
    }
  } catch {
    // Reading the header failed (unusual); fall back to the extension below.
  }
  return file.name.toLowerCase().endsWith('.mzbe');
}

async function compressGzip(data: ArrayBuffer): Promise<Blob> {
  const stream = new Blob([data]).stream().pipeThrough(
    new CompressionStream('gzip'),
  );
  return new Response(stream).blob();
}

export const backupApi = {
  /**
   * The artifact, plus whether the server could actually include every
   * attachment it names. The completeness answer travels in headers rather than
   * the body, because the body is a gzip/encrypted stream (see the backend's
   * `markIncompleteExport`). A caller that ignores `complete` shows a plain
   * success for a download the server knows cannot restore every attachment --
   * the defect this return shape exists to make hard.
   */
  exportBackup: async (
    encryptionPassword?: string,
  ): Promise<{
    blob: Blob;
    complete: boolean;
    expectedAttachments: number;
    /** Attachments the server actually wrote into the artifact. */
    includedAttachments: number;
    /** Rows whose bytes are absent from the artifact entirely. */
    missingAttachments: number;
    /**
     * Rows whose bytes are present but contradict their own metadata, so they
     * cannot be trusted either -- a different diagnosis from absent bytes.
     */
    inconsistentAttachments: number;
  }> => {
    const headers: Record<string, string> = {};
    if (encryptionPassword) {
      headers['X-Export-Password'] = encodePasswordHeader(encryptionPassword);
    }
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
      headers,
    });
    // Axios lowercases response header names, so index them lowercase (matching
    // the `content-disposition` read in supportExport below). A malformed or
    // duplicated numeric header parses to NaN; treat that as zero rather than
    // letting a "NaN of NaN attachment(s)" reach the incomplete-export toast.
    const count = (name: string): number => {
      const parsed = Number(response.headers?.[name]);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      blob: response.data,
      // Absent marker means complete: only an incomplete export sets the header,
      // so an old server or a header-stripping proxy reads as complete rather
      // than as a false alarm on every download.
      complete: String(response.headers?.['x-backup-complete']) !== 'false',
      expectedAttachments: count('x-backup-attachments-expected'),
      includedAttachments: count('x-backup-attachments-included'),
      missingAttachments: count('x-backup-attachments-missing'),
      inconsistentAttachments: count('x-backup-attachments-inconsistent'),
    };
  },

  supportExport: async (input: SupportBackupInput): Promise<SupportBackupFile> => {
    try {
      const response = await apiClient.post('/backup/support-export', input, {
        responseType: 'blob',
        timeout: 120000,
      });
      return {
        blob: response.data,
        filename: filenameFromContentDisposition(
          response.headers['content-disposition'] as string | undefined,
        ),
      };
    } catch (error) {
      return normalizeBlobError(error);
    }
  },

  supportExportPreview: async (
    input: SupportBackupInput,
  ): Promise<SupportBackupPreview> => {
    const response = await apiClient.post<SupportBackupPreview>(
      '/backup/support-export/preview',
      input,
      { timeout: 120000 },
    );
    return response.data;
  },

  // Short-lived authorization for one restore upload. The header name comes back
  // with the ticket so the client cannot drift from the server on it.
  mintRestoreUploadTicket: async (): Promise<RestoreUploadTicket> => {
    const response = await apiClient.post<RestoreUploadTicket>(
      '/backup/restore/ticket',
      {},
    );
    return response.data;
  },

  restoreBackup: async (params: {
    file: File;
    password?: string;
    oidcIdToken?: string;
    backupPassword?: string;
  }): Promise<RestoreResult> => {
    // Three accepted file shapes:
    //   *.mzbe       -> Monize encrypted envelope, sent as-is
    //   *.gz/*.json.gz -> already gzipped, sent as-is
    //   anything else -> assume raw JSON, gzip it client-side
    const ext = params.file.name.toLowerCase();
    const isEncrypted = ext.endsWith('.mzbe');
    const isAlreadyCompressed = isEncrypted || ext.endsWith('.gz');
    const body = isAlreadyCompressed
      ? params.file
      : await compressGzip(await params.file.arrayBuffer());

    // The upload's memory admission runs in front of the body parser, which is in
    // front of every backend guard -- so it cannot authenticate the request it is
    // budgeting for. This ticket is how authorization gets there first: an upload
    // without one is refused 403 before a byte is buffered. Minted here rather
    // than at page load because it is short-lived, and the file picker and any
    // password prompt happen before this call.
    const ticket = await backupApi.mintRestoreUploadTicket();

    const headers: Record<string, string> = {
      'Content-Type': isEncrypted ? 'application/octet-stream' : 'application/gzip',
      [ticket.header]: ticket.ticket,
    };
    if (params.password) {
      headers['X-Restore-Password'] = encodePasswordHeader(params.password);
    }
    if (params.oidcIdToken) {
      headers['X-Restore-OIDC-Token'] = params.oidcIdToken;
    }
    if (params.backupPassword) {
      headers['X-Backup-Password'] = encodePasswordHeader(params.backupPassword);
    }

    const response = await apiClient.post<RestoreResult>(
      '/backup/restore',
      body,
      { headers, timeout: 300000 },
    );
    // A restore replaces the whole dataset; nothing cached from before it is
    // still true.
    clearAllCache();
    return response.data;
  },

  /**
   * The automatic backups the server is holding for this user, newest first.
   *
   * Open to every signed-in account even though the schedule behind it is
   * admin-only: the files are the caller's own data, and a user who cannot
   * change the policy still has to be able to take and restore what it produced
   * for them.
   */
  listStoredBackups: async (): Promise<StoredBackupsReport> => {
    const response = await apiClient.get<StoredBackupsReport>(
      '/backup/stored-backups',
    );
    return response.data;
  },

  /**
   * One stored backup's bytes, as the file the server has on disk.
   *
   * Returned as a `File` rather than a `Blob` so it can go straight into
   * `restoreBackup`, which reads the extension to decide whether the body is
   * already compressed or an encrypted envelope -- the same decision it makes
   * for a file the user picked themselves.
   */
  downloadStoredBackup: async (filename: string): Promise<File> => {
    try {
      const response = await apiClient.get(
        `/backup/stored-backups/${encodeURIComponent(filename)}`,
        { responseType: 'blob', timeout: 120000 },
      );
      return new File([response.data], filename);
    } catch (error) {
      return normalizeBlobError(error);
    }
  },

  /**
   * The caller's own off-machine destinations. Open to every signed-in account:
   * a destination is a decision about this user's own data leaving the machine,
   * not an operator setting like the schedule behind it.
   */
  getOffsiteSettings: async (): Promise<BackupOffsiteSettingsView> => {
    const response = await apiClient.get<BackupOffsiteSettingsView>(
      '/backup/offsite-settings',
    );
    return response.data;
  },

  /**
   * Change one or more destinations. The server refuses (400) a destination it
   * could not actually use -- no deployment bucket, an incomplete own bucket, no
   * encryption key, email on with no address -- and names what to change, so the
   * caller shows that message rather than a generic failure.
   */
  updateOffsiteSettings: async (
    data: UpdateBackupOffsiteSettingsData,
  ): Promise<BackupOffsiteSettingsView> => {
    const response = await apiClient.patch<BackupOffsiteSettingsView>(
      '/backup/offsite-settings',
      data,
    );
    return response.data;
  },

  getEncryptionStatus: async (): Promise<BackupEncryptionStatus> => {
    const response = await apiClient.get<BackupEncryptionStatus>(
      '/backup/encryption',
    );
    return response.data;
  },

  // Set/clear the dedicated backup password. OIDC accounts only -- the backend
  // rejects a local-auth caller, whose password is recaptured at every login.
  setBackupPassword: async (backupPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/backup-password', {
      backupPassword,
    });
  },

  // Turn on encryption for a local account by confirming the login password it
  // already has. The sign-in capture is the primary path; this exists for a
  // session that outlived the deploy which shipped it, where nothing would
  // otherwise ask for the password again.
  enableWithLoginPassword: async (loginPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/login-password', {
      loginPassword,
    });
  },

  disableEncryption: async (): Promise<void> => {
    await apiClient.delete('/backup/encryption');
  },

  getAutoBackupSettings: async (): Promise<AutoBackupSettings> => {
    const response = await apiClient.get<AutoBackupSettings>('/backup/auto-backup-settings');
    return response.data;
  },

  /**
   * Whether this deployment can write an automatic backup at all. Saving an
   * enabled schedule already fails when it cannot -- the server creates the
   * directory and probes it -- but only after the user has chosen a frequency,
   * a time and a retention policy and pressed save, and the answer never
   * depended on any of that. This lets the section say so first.
   */
  getAutoBackupCapability: async (): Promise<AutoBackupCapability> => {
    const response = await apiClient.get<AutoBackupCapability>(
      '/backup/auto-backup-capability',
    );
    return response.data;
  },

  updateAutoBackupSettings: async (
    data: UpdateAutoBackupSettingsData,
  ): Promise<AutoBackupSettings> => {
    const response = await apiClient.patch<AutoBackupSettings>(
      '/backup/auto-backup-settings',
      data,
    );
    return response.data;
  },

  validateFolder: async (
    folderPath: string,
  ): Promise<{ valid: boolean; error?: string }> => {
    const response = await apiClient.post<{ valid: boolean; error?: string }>(
      '/backup/validate-folder',
      { folderPath },
    );
    return response.data;
  },

  browseFolders: async (
    path: string,
  ): Promise<{ current: string; directories: string[] }> => {
    const response = await apiClient.post<{ current: string; directories: string[] }>(
      '/backup/browse-folders',
      { folderPath: path },
    );
    return response.data;
  },

  runAutoBackup: async (): Promise<{ message: string; filename: string }> => {
    const response = await apiClient.post<{ message: string; filename: string }>(
      '/backup/run-auto-backup',
    );
    return response.data;
  },
};
