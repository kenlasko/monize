import apiClient from './api';
import { AutoBackupSettings, UpdateAutoBackupSettingsData } from '@/types/auth';

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

export interface RestoreResult {
  message: string;
  restored: Record<string, number>;
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
  /** Required: support backups always leave the machine encrypted. */
  password: string;
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
 * non-integer (so it can't be trivially guessed from a round value).
 */
export function randomSupportMultiplier(): number {
  const value = 1.1 + Math.random() * 8.89;
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

export interface BackupEncryptionStatus {
  enabled: boolean;
  needsBackupPassword: boolean;
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
  exportBackup: async (encryptionPassword?: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    if (encryptionPassword) {
      headers['X-Export-Password'] = encodePasswordHeader(encryptionPassword);
    }
    const response = await apiClient.post('/backup/export', {}, {
      responseType: 'blob',
      timeout: 120000,
      headers,
    });
    return response.data;
  },

  supportExport: async (input: SupportBackupInput): Promise<Blob> => {
    try {
      const response = await apiClient.post('/backup/support-export', input, {
        responseType: 'blob',
        timeout: 120000,
      });
      return response.data;
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

    const headers: Record<string, string> = {
      'Content-Type': isEncrypted ? 'application/octet-stream' : 'application/gzip',
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
    return response.data;
  },

  getEncryptionStatus: async (): Promise<BackupEncryptionStatus> => {
    const response = await apiClient.get<BackupEncryptionStatus>(
      '/backup/encryption',
    );
    return response.data;
  },

  enableLocalEncryption: async (password: string): Promise<void> => {
    await apiClient.post('/backup/encryption/enable-local', { password });
  },

  setBackupPassword: async (backupPassword: string): Promise<void> => {
    await apiClient.post('/backup/encryption/backup-password', {
      backupPassword,
    });
  },

  disableEncryption: async (): Promise<void> => {
    await apiClient.delete('/backup/encryption');
  },

  getAutoBackupSettings: async (): Promise<AutoBackupSettings> => {
    const response = await apiClient.get<AutoBackupSettings>('/backup/auto-backup-settings');
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
