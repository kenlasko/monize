import { readFileSync } from "fs";
import { join } from "path";
import { S3_REQUEST_TIMEOUT_MS } from "../../attachments/storage/s3-transport";
import {
  BACKUP_OFFSITE_KNOBS,
  normalizeOffsitePrefix,
  resolveDeploymentS3Target,
  resolveEmailMaxBytes,
  resolveMultipartPartBytes,
} from "./backup-offsite-config";

/** A getter over a plain object, which is the whole point of the signature. */
const getter =
  (env: Record<string, string | undefined>) =>
  (name: string): string | undefined =>
    env[name];

/** `.env.example` lives at the repository root, three levels above this file. */
const envExample = () =>
  readFileSync(join(__dirname, "..", "..", "..", "..", ".env.example"), "utf8");

describe("resolveDeploymentS3Target", () => {
  it("has no destination until a bucket is named", () => {
    // Every other variable set and no bucket is still no destination: it is the
    // bucket that makes `s3Mode = deployment` a thing a user can choose, and
    // inferring one from a region or an endpoint would offer them a copy that
    // lands nowhere.
    expect(
      resolveDeploymentS3Target(
        getter({
          BACKUP_S3_REGION: "eu-west-1",
          BACKUP_S3_ENDPOINT: "http://minio:9000",
          BACKUP_S3_ACCESS_KEY_ID: "AKIA",
          BACKUP_S3_SECRET_ACCESS_KEY: "secret",
        }),
      ),
    ).toBeNull();
  });

  it("treats a blank bucket as unset", () => {
    expect(
      resolveDeploymentS3Target(getter({ BACKUP_S3_BUCKET: "   " })),
    ).toBeNull();
  });

  it("reads a fully configured destination", () => {
    expect(
      resolveDeploymentS3Target(
        getter({
          BACKUP_S3_BUCKET: "my-monize-offsite",
          BACKUP_S3_REGION: "eu-west-1",
          BACKUP_S3_PREFIX: "backups",
          BACKUP_S3_ENDPOINT: "http://minio:9000",
          BACKUP_S3_FORCE_PATH_STYLE: "true",
          BACKUP_S3_ACCESS_KEY_ID: "AKIA",
          BACKUP_S3_SECRET_ACCESS_KEY: "secret",
          BACKUP_S3_REQUEST_TIMEOUT_MS: "60000",
          BACKUP_S3_MULTIPART_PART_BYTES: "8388608",
        }),
      ),
    ).toEqual({
      bucket: "my-monize-offsite",
      region: "eu-west-1",
      prefix: "backups/",
      endpoint: "http://minio:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      deadlineMs: 60_000,
      multipartPartBytes: 8_388_608,
    });
  });

  it("leaves the optional halves out rather than defaulting them", () => {
    const target = resolveDeploymentS3Target(
      getter({ BACKUP_S3_BUCKET: "bucket" }),
    );
    expect(target).toEqual({
      bucket: "bucket",
      forcePathStyle: false,
      deadlineMs: S3_REQUEST_TIMEOUT_MS,
      multipartPartBytes: BACKUP_OFFSITE_KNOBS.multipartPartBytes.default,
    });
    // No credentials key at all: the default AWS credential chain, which is a
    // different thing from an empty key pair.
    expect(target && "credentials" in target).toBe(false);
  });

  it.each([
    ["one trailing slash from none", "backups", "backups/"],
    ["one trailing slash from several", "backups///", "backups/"],
    ["a nested prefix", "monize/offsite/", "monize/offsite/"],
  ])("normalises a prefix: %s", (_label, configured, expected) => {
    expect(
      resolveDeploymentS3Target(
        getter({ BACKUP_S3_BUCKET: "bucket", BACKUP_S3_PREFIX: configured }),
      )?.prefix,
    ).toBe(expected);
  });

  it("only path-styles for the exact string true", () => {
    // A boolean environment variable is a string; comparing it as one is the
    // rule `docs/backend/modules-and-runtime.md` states, and "TRUE"/"1" being
    // false here is the visible half of it.
    for (const raw of ["false", "TRUE", "1", "yes", ""]) {
      expect(
        resolveDeploymentS3Target(
          getter({
            BACKUP_S3_BUCKET: "bucket",
            BACKUP_S3_FORCE_PATH_STYLE: raw,
          }),
        )?.forcePathStyle,
      ).toBe(false);
    }
  });

  it("signs with a key pair only when both halves are set", () => {
    const onInvalid = jest.fn();
    const target = resolveDeploymentS3Target(
      getter({
        BACKUP_S3_BUCKET: "bucket",
        BACKUP_S3_ACCESS_KEY_ID: "AKIA",
      }),
      onInvalid,
    );
    // Half a key pair is not a credential: signing with it fails in a way that
    // reads like a permissions problem, so the default chain is used instead
    // and the operator is told which half is missing.
    expect(target && "credentials" in target).toBe(false);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0][0]).toContain("BACKUP_S3_SECRET_ACCESS_KEY");
  });

  it("clamps the deadline down and never up", () => {
    const beyond = String(S3_REQUEST_TIMEOUT_MS * 10);
    expect(
      resolveDeploymentS3Target(
        getter({
          BACKUP_S3_BUCKET: "bucket",
          BACKUP_S3_REQUEST_TIMEOUT_MS: beyond,
        }),
      )?.deadlineMs,
    ).toBe(S3_REQUEST_TIMEOUT_MS);
  });
});

describe("resolveMultipartPartBytes", () => {
  it("defaults to 16 MiB when nothing is set", () => {
    expect(resolveMultipartPartBytes(getter({}))).toBe(16 * 1024 * 1024);
  });

  it("reads an operator override", () => {
    expect(
      resolveMultipartPartBytes(
        getter({ BACKUP_S3_MULTIPART_PART_BYTES: "33554432" }),
      ),
    ).toBe(33_554_432);
  });

  it("raises a part size below S3's 5 MiB floor, and says so", () => {
    // The floor is the destination's, not ours: every part but the last must be
    // at least 5 MiB, and a smaller one is refused with EntityTooSmall after the
    // bytes have already been sent. Honouring the configured number would fail
    // the copy of a backup to respect a value S3 will not accept.
    const onInvalid = jest.fn();
    expect(
      resolveMultipartPartBytes(
        getter({ BACKUP_S3_MULTIPART_PART_BYTES: "1048576" }),
        onInvalid,
      ),
    ).toBe(5 * 1024 * 1024);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0][0]).toContain(
      "BACKUP_S3_MULTIPART_PART_BYTES",
    );
  });

  it.each([
    ["not a number", "sixteen"],
    ["zero", "0"],
    ["a negative", "-1"],
    ["a fraction", "1.5"],
  ])("falls back and reports %s", (_label, raw) => {
    const onInvalid = jest.fn();
    expect(
      resolveMultipartPartBytes(
        getter({ BACKUP_S3_MULTIPART_PART_BYTES: raw }),
        onInvalid,
      ),
    ).toBe(BACKUP_OFFSITE_KNOBS.multipartPartBytes.default);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it("says nothing about an unset variable", () => {
    const onInvalid = jest.fn();
    resolveMultipartPartBytes(
      getter({ BACKUP_S3_MULTIPART_PART_BYTES: "  " }),
      onInvalid,
    );
    expect(onInvalid).not.toHaveBeenCalled();
  });
});

describe("resolveEmailMaxBytes", () => {
  it("defaults to 20 MiB when nothing is set", () => {
    expect(resolveEmailMaxBytes(getter({}))).toBe(20 * 1024 * 1024);
  });

  it("reads an operator override", () => {
    expect(
      resolveEmailMaxBytes(getter({ BACKUP_EMAIL_MAX_BYTES: "5242880" })),
    ).toBe(5_242_880);
  });

  it("falls back and reports an unreadable value", () => {
    const onInvalid = jest.fn();
    expect(
      resolveEmailMaxBytes(
        getter({ BACKUP_EMAIL_MAX_BYTES: "20mb" }),
        onInvalid,
      ),
    ).toBe(BACKUP_OFFSITE_KNOBS.emailMaxBytes.default);
    expect(onInvalid.mock.calls[0][0]).toContain("BACKUP_EMAIL_MAX_BYTES");
  });
});

describe("normalizeOffsitePrefix", () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ["", undefined],
    ["   ", undefined],
    ["/", undefined],
    ["backups", "backups/"],
    ["backups/", "backups/"],
  ])("normalises %p to %p", (input, expected) => {
    expect(normalizeOffsitePrefix(input)).toBe(expected);
  });
});

/**
 * The knob table and `.env.example` are checked against each other in both
 * directions, the way `restore-queue-config.spec.ts` does it: a knob nobody
 * documented is a knob nobody can find, and a documented line the code does not
 * read is a promise the deployment cannot keep.
 */
describe("the declared knobs and their documentation", () => {
  it("documents every knob with its current default", () => {
    const text = envExample();
    for (const spec of Object.values(BACKUP_OFFSITE_KNOBS)) {
      expect(text).toContain(`# ${spec.envVar}=${spec.default}`);
    }
  });

  it("documents every deployment destination variable this file reads", () => {
    const text = envExample();
    for (const name of [
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_REGION",
      "BACKUP_S3_PREFIX",
      "BACKUP_S3_ENDPOINT",
      "BACKUP_S3_FORCE_PATH_STYLE",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
      "BACKUP_S3_REQUEST_TIMEOUT_MS",
    ]) {
      expect(text).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
    }
  });

  /**
   * The append-only requirement is the operator's half of INV-BACKUP-004, and
   * the only place it is stated to the person who issues the token. A
   * credential comment that stopped saying it would leave the invariant resting
   * on one layer.
   */
  it("states the append-only IAM policy beside the credential", () => {
    const text = envExample();
    expect(text).toContain("s3:PutObject");
    expect(text).toContain("s3:AbortMultipartUpload");
    expect(text).toMatch(/object lock/i);
    expect(text).toMatch(/versioning/i);
  });

  it("gives every knob a description a warning can quote", () => {
    for (const spec of Object.values(BACKUP_OFFSITE_KNOBS)) {
      expect(spec.description.trim().length).toBeGreaterThan(10);
    }
  });
});
