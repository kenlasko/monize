import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
  X509Certificate,
} from "crypto";

import { ipBytes } from "./der";
import { MDNS_DOMAIN } from "./names";
import { CONSTRAINED_RANGES } from "./ranges";
import {
  basicConstraints,
  buildCertificate,
  DistinguishedName,
  KEY_USAGE,
  keyUsage,
  nameConstraints,
  serverAuthUsage,
  subjectAltName,
  SubjectNames,
  toPem,
} from "./x509";

/**
 * The per-install root certificate authority and the server certificate it
 * issues (docs/future-plans/desktop-lan-access.md, L4 and L5, section 5).
 *
 * The root is what a person installs on their phone, once. Its Name
 * Constraints permit `.local` names and the private address ranges only, so
 * even a stolen root key could not vouch for any site on the internet to a
 * device that enforces them. The server certificate is reissued whenever the
 * addresses it must name change, which costs nobody anything because the root
 * stays the same.
 */

export const ROOT_VALIDITY_DAYS = 3650;
/** Inside every platform's limit for a certificate from a user-added root. */
export const SERVER_VALIDITY_DAYS = 397;
/** Reissued on start once fewer than this many days are left. */
export const RENEW_BEFORE_DAYS = 30;
/** Devices whose clocks run a little behind still accept a fresh certificate. */
export const BACKDATE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const ORGANIZATION = "Monize";

export interface PemPair {
  readonly certPem: string;
  readonly keyPem: string;
}

function newKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

/** 128 random bits, the top bit clear so the INTEGER stays positive. */
function serialNumber(): Buffer {
  const serial = randomBytes(16);
  serial[0] = ((serial[0] as number) & 0x7f) | 0x01;
  return serial;
}

function keyPem(key: KeyObject): string {
  return (key.export({ type: "pkcs8", format: "pem" }) as string).trim();
}

/**
 * The root's subject, which a phone shows in its list of installed roots.
 * Kept to characters no name printer escapes, so `subjectOf` reads back
 * exactly what was written.
 */
export function rootSubject(computerName: string): DistinguishedName {
  const safe = computerName.replace(/[^A-Za-z0-9 ._-]/g, "").trim();
  return {
    organization: ORGANIZATION,
    commonName: (safe === "" ? "Monize" : `Monize on ${safe}`).slice(0, 64),
  };
}

export function issueRoot(options: {
  readonly computerName: string;
  readonly now: Date;
}): PemPair {
  const { publicKey, privateKey } = newKeyPair();
  const subject = rootSubject(options.computerName);
  const der = buildCertificate({
    serial: serialNumber(),
    issuer: subject,
    subject,
    notBefore: new Date(options.now.getTime() - BACKDATE_MS),
    notAfter: new Date(options.now.getTime() + ROOT_VALIDITY_DAYS * DAY_MS),
    publicKey,
    issuerPublicKey: publicKey,
    signingKey: privateKey,
    extensions: [
      basicConstraints(true, 0),
      keyUsage([KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign]),
      nameConstraints([MDNS_DOMAIN], CONSTRAINED_RANGES),
    ],
  });
  return { certPem: toPem(der), keyPem: keyPem(privateKey) };
}

/** The issuer name exactly as the root certificate carries it. */
function subjectOf(root: X509Certificate): DistinguishedName {
  const fields = new Map(
    root.subject.split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)] as const;
    }),
  );
  const commonName = fields.get("CN");
  if (commonName === undefined) {
    throw new Error("The root certificate has no common name.");
  }
  const organization = fields.get("O");
  return organization === undefined
    ? { commonName }
    : { organization, commonName };
}

export function issueServer(options: {
  readonly root: PemPair;
  readonly names: SubjectNames;
  readonly now: Date;
}): PemPair {
  if (options.names.dns.length === 0 && options.names.ip.length === 0) {
    throw new Error("A server certificate needs at least one name.");
  }
  const root = new X509Certificate(options.root.certPem);
  const rootKey = createPrivateKey(options.root.keyPem);
  const { publicKey, privateKey } = newKeyPair();
  const der = buildCertificate({
    serial: serialNumber(),
    issuer: subjectOf(root),
    subject: {
      organization: ORGANIZATION,
      commonName: options.names.dns[0] ?? (options.names.ip[0] as string),
    },
    notBefore: new Date(options.now.getTime() - BACKDATE_MS),
    notAfter: new Date(options.now.getTime() + SERVER_VALIDITY_DAYS * DAY_MS),
    publicKey,
    issuerPublicKey: createPublicKey(rootKey),
    signingKey: rootKey,
    extensions: [
      basicConstraints(false),
      keyUsage([KEY_USAGE.digitalSignature]),
      serverAuthUsage(),
      subjectAltName(options.names),
    ],
  });
  return { certPem: toPem(der), keyPem: keyPem(privateKey) };
}

/** Names in a comparable form: DNS lower-cased, IPs as hex bytes, both sorted. */
export function normalizeNames(names: SubjectNames): SubjectNames {
  return {
    dns: [...new Set(names.dns.map((dns) => dns.toLowerCase()))].sort(),
    ip: [...new Set(names.ip.map((ip) => ipBytes(ip).toString("hex")))].sort(),
  };
}

/** The subject alternative names a certificate carries, normalized. */
export function certificateNames(cert: X509Certificate): SubjectNames {
  const dns: string[] = [];
  const ip: string[] = [];
  for (const entry of (cert.subjectAltName ?? "").split(", ")) {
    if (entry.startsWith("DNS:")) dns.push(entry.slice(4));
    else if (entry.startsWith("IP Address:")) ip.push(entry.slice(11));
  }
  return normalizeNames({ dns, ip });
}

export type ReissueReason = "other-root" | "expiring" | "names-changed";

/**
 * Why the server certificate must be issued again, or null when it is good:
 * it was not signed by this root, it has fewer than RENEW_BEFORE_DAYS left (or
 * is not yet valid), or it does not name exactly `names`.
 */
export function serverReissueReason(options: {
  readonly rootCertPem: string;
  readonly serverCertPem: string;
  readonly names: SubjectNames;
  readonly now: Date;
}): ReissueReason | null {
  const root = new X509Certificate(options.rootCertPem);
  const server = new X509Certificate(options.serverCertPem);
  if (!server.checkIssued(root) || !server.verify(root.publicKey)) {
    return "other-root";
  }
  const now = options.now.getTime();
  const notBefore = new Date(server.validFrom).getTime();
  const notAfter = new Date(server.validTo).getTime();
  if (now < notBefore || notAfter - now < RENEW_BEFORE_DAYS * DAY_MS) {
    return "expiring";
  }
  const have = certificateNames(server);
  const want = normalizeNames(options.names);
  const same =
    have.dns.join() === want.dns.join() && have.ip.join() === want.ip.join();
  return same ? null : "names-changed";
}

/** `AB:CD:...`, the SHA-256 fingerprint a phone shows for an installed root. */
export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

/** The DER bytes a device downloads as `monize-root.crt`. */
export function derOf(certPem: string): Buffer {
  return Buffer.from(new X509Certificate(certPem).raw);
}
