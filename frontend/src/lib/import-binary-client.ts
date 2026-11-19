import apiClient from './api';
import { clearAllCache } from './apiCache';
import type {
  BinaryImportClient,
  MnyImportJob,
  MnyImportOptionsInput,
  MnyPreview,
} from './import-mny';

/**
 * The client behind the Microsoft Money (`.mny`) and KMyMoney (`.kmy`) import
 * endpoints, which share one shape under `/import/<format>/`.
 *
 * Two things differ from the QIF/OFX/CSV client. The file goes up as multipart
 * binary rather than as text in a JSON body -- a `.mny` file is a Jet database
 * and reading it with `File.text()` would corrupt it. And the import is a
 * background job, so `start` returns a job to poll rather than a result.
 *
 * Timeouts are per call because the defaults cannot fit both: decrypting and
 * parsing a 200 MB file takes far longer than the shared 10 s, while a poll that
 * hangs for 10 s makes the progress bar feel broken.
 *
 * Kept free of runtime imports from `import-mny.ts` (types only) so each
 * format's module stays importable on its own.
 */

/** Upload + parse of a 200 MB-class file, including the round trip. */
const PARSE_TIMEOUT_MS = 300_000;
/**
 * Starting is normally an insert and a return -- except with "start fresh",
 * where the wipe runs **inside** this request on purpose, so its credentials
 * never reach the job row. Deleting a populated profile does not fit in the
 * shared 10 s, and timing out here is worse than slow: the server carries on
 * wiping and importing while the wizard reports a failed start.
 */
const START_TIMEOUT_MS = 120_000;
/** A poll is a single indexed row read; anything slower is a real problem. */
const POLL_TIMEOUT_MS = 10_000;

/** `basePath` is the API path of one format, e.g. `/import/mny`. */
export function createBinaryImportClient(
  basePath: string,
): BinaryImportClient {
  return {
    /**
     * Uploads the file, decrypts and previews it, and stages it for import.
     * The password is sent only on this call and is never stored server-side.
     */
    parse: async (file: File, password?: string): Promise<MnyPreview> => {
      const formData = new FormData();
      formData.append('file', file);
      if (password) {
        formData.append('password', password);
      }
      const response = await apiClient.post<MnyPreview>(
        `${basePath}/parse`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: PARSE_TIMEOUT_MS,
        },
      );
      return response.data;
    },

    start: async (
      stagedFileId: string,
      options?: MnyImportOptionsInput,
      wipeCredentials?: { password?: string; oidcIdToken?: string },
    ): Promise<MnyImportJob> => {
      const response = await apiClient.post<MnyImportJob>(
        `${basePath}/start`,
        {
          stagedFileId,
          ...(options ? { options } : {}),
          ...(wipeCredentials?.password
            ? { wipePassword: wipeCredentials.password }
            : {}),
          ...(wipeCredentials?.oidcIdToken
            ? { wipeOidcIdToken: wipeCredentials.oidcIdToken }
            : {}),
        },
        { timeout: START_TIMEOUT_MS },
      );
      return response.data;
    },

    getJob: async (id: string): Promise<MnyImportJob> => {
      const response = await apiClient.get<MnyImportJob>(
        `${basePath}/jobs/${id}`,
        { timeout: POLL_TIMEOUT_MS },
      );
      // The import runs server-side after `start` returns, so the write lands
      // here rather than at a mutation call. A failed job can still have
      // written rows before it stopped, so both terminal states invalidate. An
      // import writes accounts, categories, payees, tags, securities and
      // schedules, and a wipe deletes them, so no prefix is narrow enough.
      if (
        response.data.status === 'completed' ||
        response.data.status === 'failed'
      ) {
        clearAllCache();
      }
      return response.data;
    },

    discardStagedFile: async (id: string): Promise<void> => {
      await apiClient.delete(`${basePath}/staged/${id}`);
    },
  };
}
