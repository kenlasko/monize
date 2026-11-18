import { createHash, KeyObject, sign } from "crypto";

import {
  bitString,
  boolean,
  explicit,
  ia5String,
  implicitConstructed,
  implicitPrimitive,
  integer,
  ipBytes,
  octetString,
  oid,
  prefixMask,
  sequence,
  set,
  time,
  utf8String,
} from "./der";
import { IpRange } from "./ranges";

/**
 * An X.509 v3 certificate (RFC 5280), built and signed with an ECDSA P-256
 * key. Only what the local-network root and its server certificate use is
 * here; `certificate-authority.ts` decides what goes into each.
 */

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

export interface DistinguishedName {
  readonly commonName: string;
  readonly organization?: string;
}

export interface SubjectNames {
  readonly dns: readonly string[];
  readonly ip: readonly string[];
}

/** RFC 5280 key usage bits, by their position in the BIT STRING. */
export const KEY_USAGE = {
  digitalSignature: 0,
  keyCertSign: 5,
  cRLSign: 6,
} as const;

export interface CertificateSpec {
  readonly serial: Buffer;
  readonly issuer: DistinguishedName;
  readonly subject: DistinguishedName;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** The certified key. */
  readonly publicKey: KeyObject;
  /** The issuer's public key, for the authority key identifier. */
  readonly issuerPublicKey: KeyObject;
  /** The issuer's private key, which signs. */
  readonly signingKey: KeyObject;
  readonly extensions: readonly Buffer[];
}

function name(dn: DistinguishedName): Buffer {
  const rdn = (type: string, value: string): Buffer =>
    set(sequence(oid(type), utf8String(value)));
  return sequence(
    ...(dn.organization === undefined
      ? []
      : [rdn(OID.organization, dn.organization)]),
    rdn(OID.commonName, dn.commonName),
  );
}

const SIGNATURE_ALGORITHM = sequence(oid(OID.ecdsaWithSha256));

function spki(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}

/** A key identifier: the leftmost 160 bits of SHA-256 over the SPKI (RFC 7093). */
export function keyIdentifier(key: KeyObject): Buffer {
  return createHash("sha256").update(spki(key)).digest().subarray(0, 20);
}

function extension(type: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(type),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

export function basicConstraints(ca: boolean, pathLength?: number): Buffer {
  const value = ca
    ? sequence(
        boolean(true),
        ...(pathLength === undefined ? [] : [integer(pathLength)]),
      )
    : sequence();
  return extension(OID.basicConstraints, true, value);
}

export function keyUsage(bits: readonly number[]): Buffer {
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) {
    bytes[Math.floor(bit / 8)] =
      (bytes[Math.floor(bit / 8)] as number) | (0x80 >> (bit % 8));
  }
  return extension(OID.keyUsage, true, bitString(bytes, 7 - (highest % 8)));
}

export function serverAuthUsage(): Buffer {
  return extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth)));
}

function generalNames(names: SubjectNames): Buffer[] {
  return [
    ...names.dns.map((dns) => implicitPrimitive(2, Buffer.from(dns, "ascii"))),
    ...names.ip.map((ip) => implicitPrimitive(7, ipBytes(ip))),
  ];
}

export function subjectAltName(names: SubjectNames): Buffer {
  for (const dns of names.dns) ia5String(dns);
  return extension(OID.subjectAltName, false, sequence(...generalNames(names)));
}

/**
 * Permitted subtrees only: a DNS name is permitted when it is one of
 * `dnsSuffixes` or ends in `.` plus one (RFC 5280 section 4.2.1.10), an IP
 * address when it is inside one of `ipRanges`. Marked critical, as the RFC
 * requires, so a verifier that cannot apply it refuses the chain rather than
 * ignoring it.
 */
export function nameConstraints(
  dnsSuffixes: readonly string[],
  ipRanges: readonly IpRange[],
): Buffer {
  const subtrees = [
    ...dnsSuffixes.map((suffix) =>
      sequence(implicitPrimitive(2, Buffer.from(suffix, "ascii"))),
    ),
    ...ipRanges.map((range) => {
      const address = ipBytes(range.address);
      const mask = prefixMask(range.prefix, address.length as 4 | 16);
      return sequence(implicitPrimitive(7, Buffer.concat([address, mask])));
    }),
  ];
  return extension(
    OID.nameConstraints,
    true,
    sequence(implicitConstructed(0, Buffer.concat(subtrees))),
  );
}

export function subjectKeyIdentifier(key: KeyObject): Buffer {
  return extension(
    OID.subjectKeyIdentifier,
    false,
    octetString(keyIdentifier(key)),
  );
}

export function authorityKeyIdentifier(issuerKey: KeyObject): Buffer {
  return extension(
    OID.authorityKeyIdentifier,
    false,
    sequence(implicitPrimitive(0, keyIdentifier(issuerKey))),
  );
}

/** The signed certificate, DER-encoded. */
export function buildCertificate(spec: CertificateSpec): Buffer {
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(spec.serial),
    SIGNATURE_ALGORITHM,
    name(spec.issuer),
    sequence(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spki(spec.publicKey),
    explicit(
      3,
      sequence(
        ...spec.extensions,
        subjectKeyIdentifier(spec.publicKey),
        authorityKeyIdentifier(spec.issuerPublicKey),
      ),
    ),
  );
  const signature = sign("sha256", tbs, spec.signingKey);
  return sequence(tbs, SIGNATURE_ALGORITHM, bitString(signature));
}

export function toPem(der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body.replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}
