import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createHash } from "crypto";
import { Logger } from "@nestjs/common";
import { BackupOffsiteS3Uploader } from "./backup-offsite-s3.uploader";
import { OffsiteS3Target } from "./backup-offsite.types";

/**
 * The append-only upload, proven against an endpoint that implements the S3
 * semantics it relies on rather than against a mocked SDK (INV-BACKUP-004,
 * INV-BACKUP-005).
 *
 * A mock would record that `PutObjectCommand` was constructed with
 * `IfNoneMatch`, which was never the question. The claims are: that a key the
 * destination already holds is not replaced, that bytes the destination rejects
 * are never reported as a copy, that a put whose checksum the destination does
 * not confirm is likewise not reported as a copy, and that a multipart failure
 * leaves parts cleaned up rather than accumulating. Each of those is a property
 * of the exchange -- conditional headers, checksum validation, the multipart
 * sequence -- so the endpoint here computes SHA-256 over what it actually
 * received and answers the way S3 documents. `s3-storage.provider.deadline.spec.ts`
 * established the pattern.
 *
 * The server's `DELETE ...?uploadId=` route is AbortMultipartUpload, which
 * discards *incomplete parts* and cannot touch an object. The uploader's own ban
 * is on delete/read commands and is held by `backup-offsite.guard.spec.ts`.
 */
describe("BackupOffsiteS3Uploader against a fake S3 endpoint", () => {
  const DEADLINE_MS = 3000;
  /** Comfortably above every single-put fixture below. */
  const PART_BYTES = 1024;
  /** Small enough that a short string is several parts. */
  const MULTIPART_PART_BYTES = 5;

  let server: http.Server;
  let port: number;
  const sockets = new Set<Socket>();

  /** What the endpoint holds, and what it was asked. */
  interface StoredObject {
    body: Buffer;
    checksum: string;
  }
  interface PendingUpload {
    key: string;
    parts: Map<number, Buffer>;
  }
  let objects: Map<string, StoredObject>;
  let uploads: Map<string, PendingUpload>;
  let aborted: string[];
  let requests: {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
  }[];
  /** Part number the endpoint refuses, to fail a multipart mid-sequence. */
  let refusePart: number | null;
  /** Answer a single put without the checksum header S3 echoes. */
  let echoChecksum: boolean;
  let uploadCounter: number;

  const base64Sha = (data: Buffer): string =>
    createHash("sha256").update(data).digest("base64");
  const hexSha = (data: Buffer): string =>
    createHash("sha256").update(data).digest("hex");

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  const xml = (body: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>${body}`;

  const sendError = (
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(
      xml(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`),
    );
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
        });
        // Path style: /<bucket>/<key...>
        const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = url.searchParams.get("partNumber");
        const body = await readBody(req);

        if (req.method === "POST" && url.searchParams.has("uploads")) {
          uploadCounter += 1;
          const id = `upload-${uploadCounter}`;
          uploads.set(id, { key, parts: new Map() });
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(
            xml(
              `<InitiateMultipartUploadResult><Bucket>offsite</Bucket>` +
                `<Key>${key}</Key><UploadId>${id}</UploadId>` +
                `</InitiateMultipartUploadResult>`,
            ),
          );
          return;
        }

        if (req.method === "PUT" && uploadId && partNumber) {
          const pending = uploads.get(uploadId);
          if (!pending) {
            sendError(res, 404, "NoSuchUpload", "No such upload");
            return;
          }
          if (Number(partNumber) === refusePart) {
            sendError(res, 400, "InvalidPart", "This part is not acceptable");
            return;
          }
          const declared = req.headers["x-amz-checksum-sha256"];
          const actual = base64Sha(body);
          if (declared !== actual) {
            sendError(res, 400, "BadDigest", "Part checksum mismatch");
            return;
          }
          pending.parts.set(Number(partNumber), body);
          res.writeHead(200, {
            etag: `"part-${partNumber}"`,
            "x-amz-checksum-sha256": actual,
          });
          res.end();
          return;
        }

        if (req.method === "POST" && uploadId) {
          const pending = uploads.get(uploadId);
          if (!pending) {
            sendError(res, 404, "NoSuchUpload", "No such upload");
            return;
          }
          if (req.headers["if-none-match"] === "*" && objects.has(key)) {
            sendError(
              res,
              412,
              "PreconditionFailed",
              "At least one of the pre-conditions you specified did not hold",
            );
            return;
          }
          const ordered = [...pending.parts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, part]) => part);
          const assembled = Buffer.concat(ordered);
          objects.set(key, { body: assembled, checksum: base64Sha(assembled) });
          uploads.delete(uploadId);
          // The composite form a real multipart object carries.
          const composite = `${base64Sha(
            Buffer.concat(
              ordered.map((part) => createHash("sha256").update(part).digest()),
            ),
          )}-${ordered.length}`;
          res.writeHead(200, { "content-type": "application/xml" });
          res.end(
            xml(
              `<CompleteMultipartUploadResult><Location>http://127.0.0.1/${key}` +
                `</Location><Bucket>offsite</Bucket><Key>${key}</Key>` +
                `<ETag>"assembled"</ETag><ChecksumSHA256>${composite}` +
                `</ChecksumSHA256></CompleteMultipartUploadResult>`,
            ),
          );
          return;
        }

        if (req.method === "DELETE" && uploadId) {
          aborted.push(uploadId);
          uploads.delete(uploadId);
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "PUT") {
          if (req.headers["if-none-match"] === "*" && objects.has(key)) {
            sendError(
              res,
              412,
              "PreconditionFailed",
              "At least one of the pre-conditions you specified did not hold",
            );
            return;
          }
          const declared = req.headers["x-amz-checksum-sha256"];
          const actual = base64Sha(body);
          if (declared !== actual) {
            // S3 validates the declared checksum against the bytes it received
            // and stores nothing when they disagree.
            sendError(
              res,
              400,
              "BadDigest",
              "The SHA256 you specified did not match what we received",
            );
            return;
          }
          objects.set(key, { body, checksum: actual });
          res.writeHead(200, {
            etag: '"stored"',
            ...(echoChecksum ? { "x-amz-checksum-sha256": actual } : {}),
          });
          res.end();
          return;
        }

        sendError(res, 405, "MethodNotAllowed", "Unsupported in this fake");
      })();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    objects = new Map();
    uploads = new Map();
    aborted = [];
    requests = [];
    refusePart = null;
    echoChecksum = true;
    uploadCounter = 0;
  });

  const targetFor = (
    overrides: Partial<OffsiteS3Target> = {},
  ): OffsiteS3Target => ({
    bucket: "offsite",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    deadlineMs: DEADLINE_MS,
    multipartPartBytes: PART_BYTES,
    ...overrides,
  });

  /** The sharded, digest-disambiguated key shape the dispatcher composes. */
  const keyFor = (digest: string): string =>
    `55/55/55555555-5555-5555-5555-555555555555/monize-backup-daily-2026-09-14-${digest.slice(0, 12)}.mzbe`;

  const uploader = new BackupOffsiteS3Uploader();

  it("uploads the artifact and the destination holds exactly those bytes", async () => {
    const body = Buffer.from("encrypted-artifact");
    const digest = hexSha(body);

    const result = await uploader.upload(
      targetFor({ prefix: "backups/" }),
      keyFor(digest),
      body,
      digest,
    );

    expect(result).toEqual({
      outcome: "uploaded",
      objectKey: `backups/${keyFor(digest)}`,
    });
    const stored = objects.get(`backups/${keyFor(digest)}`);
    expect(stored?.body.equals(body)).toBe(true);
    // Verified by the destination, not by us: it recomputed the SHA-256 over
    // what arrived and echoed it back.
    expect(stored?.checksum).toBe(
      createHash("sha256").update(body).digest("base64"),
    );
  });

  it("accepts a dotted key prefix the settings DTO admits", async () => {
    // `S3_KEY_PREFIX` in the DTO allows a dot, so a user is told `my.backups/`
    // is a valid prefix. The uploader validated prefix segments with the
    // attachment key alphabet, which forbids the dot, so every put under such a
    // prefix threw before the key ever left -- a configuration accepted at save
    // time that failed permanently at 02:00. The prefix now shares the DTO's
    // alphabet.
    const body = Buffer.from("encrypted-artifact");
    const digest = hexSha(body);

    const result = await uploader.upload(
      targetFor({ prefix: "my.backups/" }),
      keyFor(digest),
      body,
      digest,
    );

    expect(result).toEqual({
      outcome: "uploaded",
      objectKey: `my.backups/${keyFor(digest)}`,
    });
    expect(objects.get(`my.backups/${keyFor(digest)}`)?.body.equals(body)).toBe(
      true,
    );
  });

  it("still refuses a prefix segment that climbs out of its area", async () => {
    const body = Buffer.from("encrypted-artifact");
    const digest = hexSha(body);
    await expect(
      uploader.upload(
        targetFor({ prefix: "../escape/" }),
        keyFor(digest),
        body,
        digest,
      ),
    ).rejects.toThrow(/safe prefix alphabet/);
  });

  it("does not overwrite a key the destination already holds", async () => {
    const first = Buffer.from("the-original-artifact");
    const digest = hexSha(first);
    const key = keyFor(digest);
    await uploader.upload(targetFor(), key, first, digest);

    // The same key with different bytes is the case the invariant is about: a
    // re-run must not be able to replace what is off-machine, whatever it holds.
    const second = Buffer.from("different-bytes-entirely");
    const result = await uploader.upload(
      targetFor(),
      key,
      second,
      hexSha(second),
    );

    expect(result.outcome).toBe("already-present");
    expect(objects.get(key)?.body.equals(first)).toBe(true);
    expect(objects.size).toBe(1);
  });

  it("sends the no-overwrite precondition on every put", async () => {
    const body = Buffer.from("artifact");
    await uploader.upload(
      targetFor(),
      keyFor(hexSha(body)),
      body,
      hexSha(body),
    );
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.headers["if-none-match"]).toBe("*");
  });

  it("throws and stores nothing when the destination rejects the bytes", async () => {
    // A corrupted transfer: the digest declared is not the digest of what
    // arrives, which is exactly what the checksum exists to catch.
    const body = Buffer.from("artifact");
    const wrongDigest = hexSha(Buffer.from("some-other-artifact"));

    await expect(
      uploader.upload(targetFor(), keyFor(wrongDigest), body, wrongDigest),
    ).rejects.toThrow(/BadDigest|did not match/);
    expect(objects.size).toBe(0);
  });

  it("refuses to report a copy the destination did not confirm", async () => {
    // A 200 is not a verification. An endpoint that ignores the checksum header
    // must not yield an "uploaded" state, or INV-BACKUP-005 records a copy
    // nobody checked.
    echoChecksum = false;
    const body = Buffer.from("artifact");
    const digest = hexSha(body);

    await expect(
      uploader.upload(targetFor(), keyFor(digest), body, digest),
    ).rejects.toThrow(/was not verified/);
  });

  it("refuses a key that is not a safe path", async () => {
    const body = Buffer.from("artifact");
    await expect(
      uploader.upload(
        targetFor(),
        "55/../../etc/monize-backup-daily-2026-09-14-abc.mzbe",
        body,
        hexSha(body),
      ),
    ).rejects.toThrow(/off-site object key/);
    expect(requests).toEqual([]);
  });

  it("refuses a digest that is not a SHA-256", async () => {
    const body = Buffer.from("artifact");
    await expect(
      uploader.upload(
        targetFor(),
        keyFor("abcdef123456"),
        body,
        "not-a-digest",
      ),
    ).rejects.toThrow(/64 hex characters/);
    expect(requests).toEqual([]);
  });

  it("uploads a large artifact as checksummed parts and completes conditionally", async () => {
    // 13 bytes at a 5-byte part size: three parts, the last one short.
    const body = Buffer.from("abcdefghijklm");
    const digest = hexSha(body);
    const key = keyFor(digest);

    const result = await uploader.upload(
      targetFor({ multipartPartBytes: MULTIPART_PART_BYTES }),
      key,
      body,
      digest,
    );

    expect(result.outcome).toBe("uploaded");
    expect(objects.get(key)?.body.equals(body)).toBe(true);
    const parts = requests.filter((request) =>
      request.url.includes("partNumber="),
    );
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part.headers["x-amz-checksum-sha256"]).toBeDefined();
    }
    const complete = requests.find(
      (request) =>
        request.method === "POST" && request.url.includes("uploadId="),
    );
    expect(complete?.headers["if-none-match"]).toBe("*");
    expect(aborted).toEqual([]);
  });

  it("aborts the incomplete upload and rethrows when a part fails", async () => {
    // Abort is the cleanup of parts that never became an object -- the parts are
    // billable and unreachable otherwise -- and is not object deletion.
    refusePart = 2;
    const body = Buffer.from("abcdefghijklm");
    const digest = hexSha(body);
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    try {
      await expect(
        uploader.upload(
          targetFor({ multipartPartBytes: MULTIPART_PART_BYTES }),
          keyFor(digest),
          body,
          digest,
        ),
      ).rejects.toThrow(/InvalidPart|not acceptable/);
      expect(aborted).toEqual(["upload-1"]);
      expect(objects.size).toBe(0);
      // The abort succeeded, so nothing was warned about leftovers.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not complete a multipart over a key that already exists", async () => {
    const existing = Buffer.from("abcdefghijklm");
    const digest = hexSha(existing);
    const key = keyFor(digest);
    await uploader.upload(
      targetFor({ multipartPartBytes: MULTIPART_PART_BYTES }),
      key,
      existing,
      digest,
    );
    const heldBefore = objects.get(key)?.body;

    const result = await uploader.upload(
      targetFor({ multipartPartBytes: MULTIPART_PART_BYTES }),
      key,
      existing,
      digest,
    );

    expect(result.outcome).toBe("already-present");
    expect(objects.get(key)?.body.equals(heldBefore as Buffer)).toBe(true);
    // The upload that could not be completed is cleaned up rather than left
    // holding parts.
    expect(aborted).toEqual(["upload-2"]);
  });

  it("refuses to send parts whose whole does not hash to the declared digest", async () => {
    // Multipart declares per-part checksums, so nothing on the far side would
    // notice the artifact landing under a key naming a different digest -- and
    // an append-only destination could never be corrected afterwards.
    const body = Buffer.from("abcdefghijklm");
    const wrongDigest = hexSha(Buffer.from("something-else-entirely"));

    await expect(
      uploader.upload(
        targetFor({ multipartPartBytes: MULTIPART_PART_BYTES }),
        keyFor(wrongDigest),
        body,
        wrongDigest,
      ),
    ).rejects.toThrow(/declared egress digest/);
    expect(objects.size).toBe(0);
    expect(aborted).toEqual(["upload-1"]);
  });
});
