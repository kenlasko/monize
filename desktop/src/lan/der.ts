import { isIPv4, isIPv6 } from "net";

/**
 * The few DER (X.690) encodings an X.509 certificate needs, and IP addresses
 * as the bytes a certificate carries them in. Node's `crypto` makes and uses
 * keys but writes no certificate; `x509.ts` builds one from these.
 *
 * Every function returns a new Buffer holding one complete TLV.
 */

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utf8String: 0x0c,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([tag]),
    lengthBytes(content.length),
    content,
  ]);
}

export function sequence(...items: readonly Buffer[]): Buffer {
  return tlv(TAG.sequence, Buffer.concat(items));
}

export function set(...items: readonly Buffer[]): Buffer {
  return tlv(TAG.set, Buffer.concat(items));
}

/** A non-negative INTEGER from its big-endian magnitude, or a small number. */
export function integer(value: Buffer | number): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`integer: ${value} is not a non-negative integer`);
    }
    const out: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
      out.unshift(rest % 256);
    }
    bytes = Buffer.from(out.length === 0 ? [0] : out);
  } else {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    bytes = value.subarray(start);
    if (bytes.length === 0) bytes = Buffer.from([0]);
  }
  // A set top bit would read as negative.
  if ((bytes[0] as number) & 0x80)
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(TAG.integer, bytes);
}

export function boolean(value: boolean): Buffer {
  return tlv(TAG.boolean, Buffer.from([value ? 0xff : 0x00]));
}

export function octetString(content: Buffer): Buffer {
  return tlv(TAG.octetString, content);
}

/** A BIT STRING whose last `unusedBits` bits are padding. */
export function bitString(content: Buffer, unusedBits = 0): Buffer {
  if (unusedBits < 0 || unusedBits > 7) {
    throw new RangeError(`bitString: ${unusedBits} unused bits`);
  }
  return tlv(
    TAG.bitString,
    Buffer.concat([Buffer.from([unusedBits]), content]),
  );
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((arc) => {
    if (!/^\d+$/.test(arc)) throw new RangeError(`oid: ${dotted}`);
    return Number(arc);
  });
  if (arcs.length < 2) throw new RangeError(`oid: ${dotted}`);
  const [first, second, ...rest] = arcs as [number, number, ...number[]];
  const out: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const chunk: number[] = [arc % 128];
    for (
      let left = Math.floor(arc / 128);
      left > 0;
      left = Math.floor(left / 128)
    ) {
      chunk.unshift(0x80 | (left % 128));
    }
    out.push(...chunk);
  }
  return tlv(TAG.oid, Buffer.from(out));
}

export function utf8String(value: string): Buffer {
  return tlv(TAG.utf8String, Buffer.from(value, "utf8"));
}

export function ia5String(value: string): Buffer {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new RangeError("ia5String: not printable ASCII");
  }
  return tlv(TAG.ia5String, Buffer.from(value, "ascii"));
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** UTCTime through 2049 and GeneralizedTime from 2050, as RFC 5280 requires. */
export function time(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    "Z";
  return year < 2050
    ? tlv(TAG.utcTime, Buffer.from(pad(year % 100, 2) + rest, "ascii"))
    : tlv(TAG.generalizedTime, Buffer.from(pad(year, 4) + rest, "ascii"));
}

/** `[n] EXPLICIT`: a constructed context tag around a complete TLV. */
export function explicit(n: number, content: Buffer): Buffer {
  return tlv(0xa0 | n, content);
}

/** `[n] IMPLICIT` for a primitive type: the content under a context tag. */
export function implicitPrimitive(n: number, content: Buffer): Buffer {
  return tlv(0x80 | n, content);
}

/** `[n] IMPLICIT` for a constructed type (a SEQUENCE OF, for instance). */
export function implicitConstructed(n: number, content: Buffer): Buffer {
  return tlv(0xa0 | n, content);
}

function ipv6Groups(address: string): number[] {
  let text = address;
  // An embedded IPv4 tail (`::ffff:192.168.1.2`) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const b = ipv4Bytes(v4[1] as string);
    text =
      text.slice(0, v4.index) +
      `${(((b[0] as number) << 8) | (b[1] as number)).toString(16)}:` +
      `${(((b[2] as number) << 8) | (b[3] as number)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) throw new RangeError(`ipv6: ${address}`);
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) {
    throw new RangeError(`ipv6: ${address}`);
  }
  return [
    ...head,
    ...new Array<number>(halves.length === 2 ? fill : 0).fill(0),
    ...tail,
  ];
}

function ipv4Bytes(address: string): Buffer {
  return Buffer.from(address.split(".").map(Number));
}

/** An IPv4 or IPv6 address as its 4 or 16 network-order bytes. */
export function ipBytes(address: string): Buffer {
  const bare = address.replace(/%.*$/, "");
  if (isIPv4(bare)) return ipv4Bytes(bare);
  if (!isIPv6(bare)) throw new RangeError(`not an IP address: ${address}`);
  const out = Buffer.alloc(16);
  ipv6Groups(bare).forEach((group, index) =>
    out.writeUInt16BE(group, index * 2),
  );
  return out;
}

/** The netmask for a prefix length, in the address family's byte count. */
export function prefixMask(prefix: number, byteLength: 4 | 16): Buffer {
  const bits = byteLength * 8;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new RangeError(`prefix /${prefix} for ${bits}-bit addresses`);
  }
  const out = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) {
    const take = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = take === 0 ? 0 : (0xff << (8 - take)) & 0xff;
  }
  return out;
}
