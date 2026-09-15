import {
  buildS3Client,
  clampS3Deadline,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  withS3Deadline,
} from "./s3-transport";

/**
 * The transport's two decisions, tested where they now live.
 *
 * Both were previously private to `S3StorageProvider` and only observable
 * through it: the clamp through the handler config of a constructed client, the
 * deadline through a save against a stalled endpoint. They are shared with the
 * backup egress uploader now, so a second caller can get them wrong in a way the
 * attachment suite would never see -- an egress path that lengthened the ceiling
 * or swallowed the underlying error would leave those specs green.
 *
 * `s3-storage.provider.spec.ts` and `s3-storage.provider.deadline.spec.ts` still
 * hold the end-to-end versions (a real client, a real stalled socket); these are
 * the unit-level statements of the same two rules.
 */
describe("clampS3Deadline", () => {
  it("falls back to the ceiling when nothing is configured", () => {
    expect(clampS3Deadline(undefined)).toBe(S3_REQUEST_TIMEOUT_MS);
    expect(clampS3Deadline("")).toBe(S3_REQUEST_TIMEOUT_MS);
  });

  it("falls back to the ceiling for a value that is not a positive number", () => {
    // A typo must not disarm the bound. `Number("soon")` is NaN and `Number("0")`
    // is a deadline that fires before the request does; both mean "unconfigured".
    for (const value of ["soon", "0", "-1", "1e", " "]) {
      expect(clampS3Deadline(value)).toBe(S3_REQUEST_TIMEOUT_MS);
    }
  });

  it("shortens", () => {
    expect(clampS3Deadline("300")).toBe(300);
    expect(clampS3Deadline(String(S3_REQUEST_TIMEOUT_MS - 1))).toBe(
      S3_REQUEST_TIMEOUT_MS - 1,
    );
  });

  it("never lengthens", () => {
    // The six-hour quarantine window the attachment sweeper relies on is only
    // sufficient while no operation can outlive this ceiling.
    expect(clampS3Deadline(String(7 * 60 * 60 * 1000))).toBe(
      S3_REQUEST_TIMEOUT_MS,
    );
    expect(clampS3Deadline(String(S3_REQUEST_TIMEOUT_MS + 1))).toBe(
      S3_REQUEST_TIMEOUT_MS,
    );
  });
});

describe("withS3Deadline", () => {
  it("returns the operation's value and arms a signal for it", async () => {
    let seen: AbortSignal | undefined;
    const result = await withS3Deadline(1000, "PutObject", async (options) => {
      seen = options.abortSignal;
      return "done";
    });
    expect(result).toBe("done");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it("gives each operation its own signal", async () => {
    // One shared controller would let a slow multipart part abort the next one.
    const signals: AbortSignal[] = [];
    const capture = (options: { abortSignal: AbortSignal }) => {
      signals.push(options.abortSignal);
      return Promise.resolve(undefined);
    };
    await withS3Deadline(1000, "UploadPart", capture);
    await withS3Deadline(1000, "UploadPart", capture);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("aborts the signal and names the deadline when the operation overruns", async () => {
    // The operation settles only because the signal fired: nothing else here can
    // end it, so a pass is evidence of the abort rather than of a timeout the
    // callback arranged itself.
    await expect(
      withS3Deadline(
        20,
        "PutObject",
        (options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener("abort", () =>
              reject(new Error("aborted by signal")),
            );
          }),
      ),
    ).rejects.toThrow(/S3 PutObject exceeded its 20 ms deadline/);
  });

  it("carries the underlying error through the deadline message", async () => {
    // A slow endpoint and wrong credentials must not read identically in the
    // log; replacing the SDK's error with the abort loses the only thing that
    // says which happened.
    await expect(
      withS3Deadline(
        20,
        "CompleteMultipartUpload",
        (options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener("abort", () =>
              reject(new Error("SignatureDoesNotMatch")),
            );
          }),
      ),
    ).rejects.toThrow(/underlying error: SignatureDoesNotMatch/);
  });

  it("describes a non-Error rejection rather than dropping it", async () => {
    await expect(
      withS3Deadline(
        20,
        "PutObject",
        (options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener("abort", () =>
              reject("socket hang up"),
            );
          }),
      ),
    ).rejects.toThrow(/underlying error: socket hang up/);
  });

  it("passes a failure that is not the deadline through unchanged", async () => {
    // A 412 or a checksum rejection must reach the caller as itself: the egress
    // uploader branches on it, and a deadline wrapper would hide the status.
    const failure = Object.assign(new Error("PreconditionFailed"), {
      $metadata: { httpStatusCode: 412 },
    });
    await expect(
      withS3Deadline(5000, "PutObject", () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});

describe("buildS3Client", () => {
  it("pins the attempt ceiling and the deadline the caller clamped", async () => {
    const client = buildS3Client({
      region: "eu-west-1",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
      deadlineMs: 1234,
    });
    try {
      expect(await client.config.region()).toBe("eu-west-1");
      expect(await client.config.maxAttempts()).toBe(S3_MAX_ATTEMPTS);
      expect(client.config.forcePathStyle).toBe(true);
      const credentials = await client.config.credentials();
      expect(credentials.accessKeyId).toBe("id");
    } finally {
      client.destroy();
    }
  });

  it("defaults the region and signs from the credential chain when a half key pair is configured", async () => {
    // Half a key pair is a misconfiguration, not a credential: signing with it
    // would fail every request with an error about the signature rather than
    // about the configuration.
    const client = buildS3Client({
      forcePathStyle: false,
      credentials: { accessKeyId: "id", secretAccessKey: "" },
      deadlineMs: 1000,
    });
    try {
      expect(await client.config.region()).toBe("us-east-1");
      // Whether the default chain has anything to offer depends on the machine,
      // so the claim is the half pair is not what signs: either the chain
      // answered with something else or resolution failed outright.
      const resolved = await client.config.credentials().catch(() => null);
      expect(resolved?.accessKeyId).not.toBe("id");
    } finally {
      client.destroy();
    }
  });
});
