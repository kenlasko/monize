import { promises as fs } from "fs";
import { join } from "path";

import { writeFileAtomic } from "../atomic-write";
import {
  SecretPolicy,
  StoredSecret,
  unwrapSecret,
  wrapSecret,
} from "../secrets";
import {
  derOf,
  fingerprintOf,
  issueRoot,
  issueServer,
  PemPair,
  ReissueReason,
  serverReissueReason,
} from "./certificate-authority";
import { SubjectNames } from "./x509";

/**
 * The `tls/` folder under the data directory: the root certificate a person
 * installs on their devices, the server certificate the LAN listener
 * presents, and both private keys, wrapped with `safeStorage` like the other
 * secrets (docs/future-plans/desktop-lan-access.md, section 4).
 *
 * The root is created once and never replaced silently: a root that cannot
 * be read is an error the person sees, because a new one means setting every
 * device up again. The server certificate is reissued whenever it is missing,
 * unreadable, close to expiry or names the wrong addresses.
 */

export const TLS_FILES = {
  rootCert: "root.crt",
  rootKey: "root-key.json",
  serverCert: "server.crt",
  serverKey: "server-key.json",
} as const;

const ROOT_KEY_NAME = "the local-network root key";
const SERVER_KEY_NAME = "the local-network server key";

export interface TlsMaterial {
  readonly rootCertPem: string;
  /** What a device downloads and installs. */
  readonly rootDer: Buffer;
  readonly rootFingerprint: string;
  readonly server: PemPair;
}

export interface TlsLoadResult {
  readonly material: TlsMaterial;
  readonly createdRoot: boolean;
  /** Why the server certificate was issued this time, or null when kept. */
  readonly issued: ReissueReason | "missing" | null;
}

export interface TlsStoreOptions {
  readonly dir: string;
  readonly policy: SecretPolicy;
  readonly computerName: string;
  readonly names: SubjectNames;
  readonly now: Date;
}

export class TlsStoreError extends Error {
  readonly code = "TLS_ROOT_DAMAGED";

  constructor(message: string) {
    super(message);
    this.name = "TlsStoreError";
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await writeFileAtomic(path, Buffer.from(text, "utf8"));
}

function parseStored(text: string, name: string): StoredSecret {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TlsStoreError(`The file holding ${name} is not valid JSON.`);
  }
  const stored = raw as Partial<StoredSecret> | null;
  if (
    stored === null ||
    typeof stored !== "object" ||
    (stored.enc !== "safeStorage" && stored.enc !== "plain") ||
    typeof stored.value !== "string"
  ) {
    throw new TlsStoreError(`The file holding ${name} is damaged.`);
  }
  return { enc: stored.enc, value: stored.value };
}

async function writeKey(
  path: string,
  keyPem: string,
  name: string,
  policy: SecretPolicy,
): Promise<void> {
  const stored = wrapSecret(keyPem.trim(), name, policy);
  await writeText(path, `${JSON.stringify(stored, null, 2)}\n`);
}

function readKey(text: string, name: string, policy: SecretPolicy): string {
  return unwrapSecret(parseStored(text, name), name, policy);
}

async function createRoot(options: TlsStoreOptions): Promise<PemPair> {
  const root = issueRoot({
    computerName: options.computerName,
    now: options.now,
  });
  // The key before the certificate: a crash between the two leaves a key
  // nobody trusts yet, never a trusted certificate whose key is gone.
  await writeKey(
    join(options.dir, TLS_FILES.rootKey),
    root.keyPem,
    ROOT_KEY_NAME,
    options.policy,
  );
  await writeText(join(options.dir, TLS_FILES.rootCert), root.certPem);
  return root;
}

async function loadRoot(
  options: TlsStoreOptions,
): Promise<{ root: PemPair; created: boolean }> {
  const certPem = await readText(join(options.dir, TLS_FILES.rootCert));
  const keyText = await readText(join(options.dir, TLS_FILES.rootKey));
  if (certPem === null) {
    // No certificate means no device can trust this root yet, so a key left
    // alone by an interrupted first run is simply replaced.
    return { root: await createRoot(options), created: true };
  }
  if (keyText === null) {
    throw new TlsStoreError(
      "The local-network root certificate is there but its key is missing, " +
        "so no new server certificate can be issued. Replace the root " +
        "certificate from the setup window, then set each device up again.",
    );
  }
  const keyPem = readKey(keyText, ROOT_KEY_NAME, options.policy);
  try {
    fingerprintOf(certPem);
  } catch {
    throw new TlsStoreError(
      "The local-network root certificate cannot be read. Replace it from " +
        "the setup window, then set each device up again.",
    );
  }
  return { root: { certPem, keyPem }, created: false };
}

async function loadServer(
  options: TlsStoreOptions,
  root: PemPair,
): Promise<{ server: PemPair; issued: TlsLoadResult["issued"] }> {
  const certPem = await readText(join(options.dir, TLS_FILES.serverCert));
  const keyText = await readText(join(options.dir, TLS_FILES.serverKey));
  let reason: TlsLoadResult["issued"] = "missing";
  if (certPem !== null && keyText !== null) {
    try {
      const keyPem = readKey(keyText, SERVER_KEY_NAME, options.policy);
      reason = serverReissueReason({
        rootCertPem: root.certPem,
        serverCertPem: certPem,
        names: options.names,
        now: options.now,
      });
      if (reason === null) return { server: { certPem, keyPem }, issued: null };
    } catch {
      // Unreadable or undecryptable: it costs nothing to issue another.
      reason = "missing";
    }
  }
  const server = issueServer({ root, names: options.names, now: options.now });
  await writeKey(
    join(options.dir, TLS_FILES.serverKey),
    server.keyPem,
    SERVER_KEY_NAME,
    options.policy,
  );
  await writeText(join(options.dir, TLS_FILES.serverCert), server.certPem);
  return { server, issued: reason };
}

function material(root: PemPair, server: PemPair): TlsMaterial {
  return {
    rootCertPem: root.certPem,
    rootDer: derOf(root.certPem),
    rootFingerprint: fingerprintOf(root.certPem),
    server,
  };
}

/** The root (created on first use) and a server certificate for `names`. */
export async function loadOrCreateTls(
  options: TlsStoreOptions,
): Promise<TlsLoadResult> {
  await fs.mkdir(options.dir, { recursive: true });
  const { root, created } = await loadRoot(options);
  const { server, issued } = await loadServer(options, root);
  return { material: material(root, server), createdRoot: created, issued };
}

/**
 * A new root and server certificate, for a PC that was compromised or given
 * away. Every device has to install the new root; the caller says so first.
 */
export async function replaceTls(
  options: TlsStoreOptions,
): Promise<TlsLoadResult> {
  await fs.mkdir(options.dir, { recursive: true });
  await fs.rm(join(options.dir, TLS_FILES.serverCert), { force: true });
  await fs.rm(join(options.dir, TLS_FILES.rootCert), { force: true });
  const root = await createRoot(options);
  const { server } = await loadServer(options, root);
  return {
    material: material(root, server),
    createdRoot: true,
    issued: "missing",
  };
}
