/**
 * How much of a request body the frontend will hold or pass on, per path.
 *
 * ## Why the ceiling lives in two places
 *
 * Next.js copies the body of every request the proxy (`src/proxy.ts`) matches
 * into memory BEFORE the proxy runs, up to `experimental.proxyClientMaxBodySize`
 * (`getCloneableBody` in `next/dist/server/body-streams.js`): one copy is handed
 * to the proxy, the other is kept to replace the request body afterwards, and
 * Next waits for the whole upload to arrive either way. Nothing the proxy does
 * -- refusing early, reading nothing -- shortens that, so the only bound on what
 * an unauthenticated request can make the frontend hold is that setting. It
 * used to be the `.mny` import ceiling (308 MB), for every path, which let a
 * single POST to `/api/v1/auth/login` pin hundreds of megabytes.
 *
 * So the setting is small (`NEXT_PROXY_CLIENT_MAX_BODY_MB`, one step above the
 * backend's own 10 MB JSON limit), and the few routes that genuinely need more
 * are kept out of the proxy's matcher entirely and served by route handlers
 * under `src/app/api/v1/` that STREAM the body to the backend with a per-route
 * ceiling (`LARGE_UPLOAD_ROUTES`, `forwardLargeUpload`). A request whose path
 * the proxy does match is refused with 413 past `DEFAULT_PROXY_BODY_LIMIT_BYTES`.
 */

const MIB = 1024 * 1024;

/**
 * The backend's default body limit (`express.json({ limit: "10mb" })` in
 * `backend/src/main.ts`), and so the most any proxied request may carry.
 */
export const DEFAULT_PROXY_BODY_LIMIT_BYTES = 10 * MIB;

/**
 * `experimental.proxyClientMaxBodySize` in `next.config.js`, in MB. One MB above
 * the default limit: Next silently truncates a body at this size, and a
 * truncated body always delivers more than the default limit (Node reads a
 * socket in chunks far smaller than the margin), so it is refused, never
 * forwarded as a stump. `proxy-body-limit.test.ts` holds the config to it.
 */
export const NEXT_PROXY_CLIENT_MAX_BODY_MB = 11;

/** Multipart framing (boundaries, part headers) that rides along with a file. */
const MULTIPART_FRAMING_BYTES = MIB;

/**
 * The `.mny` upload ceiling, read at request time from the same variable and
 * default as the backend's `MNY_IMPORT_LIMIT_MB`, so lowering one lowers both.
 */
export function mnyImportLimitBytes(
  raw: string | undefined = process.env.MNY_IMPORT_LIMIT_MB,
): number {
  const parsed = Number(raw);
  const mb = Number.isInteger(parsed) && parsed > 0 ? parsed : 300;
  // 8 MB for the multipart framing and the password field, as before.
  return (mb + 8) * MIB;
}

export interface LargeUploadRoute {
  /** The backend path, matched exactly (a trailing slash tolerated). */
  readonly pattern: RegExp;
  /** The most this route may stream to the backend. */
  readonly limitBytes: () => number;
}

/**
 * Every path allowed a body above `DEFAULT_PROXY_BODY_LIMIT_BYTES`, each with
 * the backend's own limit for it. Each one has a route handler, and the
 * proxy's `config.matcher` excludes exactly these paths (`proxy-matcher.test.ts`
 * asserts both directions).
 */
export const LARGE_UPLOAD_ROUTES: readonly LargeUploadRoute[] = [
  {
    pattern:
      /^\/api\/v1\/shared-expenses\/groups\/[^/]+\/(?:entries\/[^/]+\/)?attachments\/?$/,
    limitBytes: () => 2 * 10 * MIB + MULTIPART_FRAMING_BYTES,
  },
  // `MnyImportController.parse` (multer, MNY_IMPORT_LIMIT_MB).
  {
    pattern: /^\/api\/v1\/import\/mny\/parse\/?$/,
    limitBytes: () => mnyImportLimitBytes(),
  },
  // The restore upload. The backend's admission gate and BACKUP_RESTORE_LIMIT
  // decide; this is the ceiling the proxy has always applied to it, and the
  // body is streamed, so it costs the frontend no memory.
  {
    pattern: /^\/api\/v1\/backup\/restore\/?$/,
    limitBytes: () => mnyImportLimitBytes(),
  },
  // The assistant's attachments travel base64 in JSON (`express.json` at 30mb).
  {
    pattern: /^\/api\/v1\/ai\/query(?:\/stream)?\/?$/,
    limitBytes: () => 30 * MIB,
  },
  // The receipts archive import: the backend refuses a declared body above
  // `EMAIL_IMPORT_REQUEST_LIMIT_MB` (26 MB); this cuts an undeclared one there.
  // Kept to one file's worth: Next hands a route handler the body without
  // backpressure, so the frontend buffers what the backend has not read yet.
  {
    pattern: /^\/api\/v1\/email-receipts\/mailbox\/import\/?$/,
    limitBytes: () => 26 * MIB,
  },
  // A file and its unprocessed original, 10 MB each (`MAX_ATTACHMENT_BYTES`).
  {
    pattern: /^\/api\/v1\/transactions\/[^/]+\/attachments\/?$/,
    limitBytes: () => 2 * 10 * MIB + MULTIPART_FRAMING_BYTES,
  },
];

/** Thrown into a body stream that passed its ceiling. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the limit for this route");
    this.name = "BodyTooLargeError";
  }
}

/**
 * True when the request declares a body longer than `limitBytes`. A missing or
 * unparsable header declares nothing; the byte count while reading decides.
 */
export function declaresBodyOver(
  headers: Headers,
  limitBytes: number,
): boolean {
  const declared = Number(headers.get("content-length"));
  return Number.isFinite(declared) && declared > limitBytes;
}

/**
 * Read a body into memory, giving up -- and cancelling the stream -- as soon as
 * it passes `limitBytes`. `null` means too large. The proxy buffers rather than
 * streams because a body stream handed to it by Next has intermittently arrived
 * already locked ("expected non-null body source" from undici).
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Pass a body through unchanged, erroring the stream with `BodyTooLargeError`
 * once more than `limitBytes` has gone by. Nothing is held beyond the chunk in
 * flight.
 */
export function limitBodyStream(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limitBytes) {
          controller.error(new BodyTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
