import { isIPv4 } from "net";

import { ipBytes } from "./der";

/**
 * The slice of the DNS wire format (RFC 1035, with the mDNS bits of RFC 6762)
 * the responder in `mdns.ts` needs: read any query or response a network
 * sends, write questions and A records. Names are compared lower-cased.
 * Writing never compresses names; reading follows compression pointers, and
 * only backwards, so a hostile packet cannot loop.
 */

export const TYPE = { A: 1, AAAA: 28, ANY: 255 } as const;
export const CLASS_IN = 1;
/** In a question's class: "a unicast reply is fine" (RFC 6762 section 5.4). */
export const UNICAST_RESPONSE = 0x8000;
/** In a record's class: "this record replaces what you cached" (section 10.2). */
export const CACHE_FLUSH = 0x8000;

const FLAG_RESPONSE = 0x8000;
const FLAG_AUTHORITATIVE = 0x0400;

export interface Question {
  readonly name: string;
  readonly type: number;
  readonly unicastResponse: boolean;
}

export interface ResourceRecord {
  readonly name: string;
  readonly type: number;
  readonly cacheFlush: boolean;
  readonly ttl: number;
  readonly data: Buffer;
}

export interface Packet {
  readonly id: number;
  readonly isResponse: boolean;
  readonly questions: readonly Question[];
  readonly answers: readonly ResourceRecord[];
  readonly authorities: readonly ResourceRecord[];
  readonly additionals: readonly ResourceRecord[];
}

export class DnsPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsPacketError";
  }
}

const MAX_NAME_LENGTH = 255;

class Reader {
  offset = 0;

  constructor(readonly buffer: Buffer) {}

  need(bytes: number, at = this.offset): void {
    if (at + bytes > this.buffer.length) {
      throw new DnsPacketError("The packet ends early.");
    }
  }

  u8(): number {
    this.need(1);
    return this.buffer.readUInt8(this.offset++);
  }

  u16(): number {
    this.need(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length: number): Buffer {
    this.need(length);
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(out);
  }

  name(): string {
    const labels: string[] = [];
    let at = this.offset;
    let jumped = false;
    let length = 0;
    for (;;) {
      this.need(1, at);
      const size = this.buffer.readUInt8(at);
      if ((size & 0xc0) === 0xc0) {
        this.need(2, at);
        const target = this.buffer.readUInt16BE(at) & 0x3fff;
        if (target >= at) {
          throw new DnsPacketError("A name points forwards.");
        }
        if (!jumped) this.offset = at + 2;
        jumped = true;
        at = target;
        continue;
      }
      if ((size & 0xc0) !== 0) {
        throw new DnsPacketError("A label has an unknown type.");
      }
      if (size === 0) {
        if (!jumped) this.offset = at + 1;
        return labels.join(".").toLowerCase();
      }
      this.need(1 + size, at);
      length += size + 1;
      if (length > MAX_NAME_LENGTH) {
        throw new DnsPacketError("A name is longer than 255 bytes.");
      }
      labels.push(this.buffer.toString("latin1", at + 1, at + 1 + size));
      at += 1 + size;
    }
  }
}

function readQuestion(reader: Reader): Question {
  const name = reader.name();
  const type = reader.u16();
  const klass = reader.u16();
  return { name, type, unicastResponse: (klass & UNICAST_RESPONSE) !== 0 };
}

function readRecord(reader: Reader): ResourceRecord {
  const name = reader.name();
  const type = reader.u16();
  const klass = reader.u16();
  const ttl = reader.u32();
  const length = reader.u16();
  return {
    name,
    type,
    cacheFlush: (klass & CACHE_FLUSH) !== 0,
    ttl,
    data: reader.bytes(length),
  };
}

export function decodePacket(buffer: Buffer): Packet {
  const reader = new Reader(buffer);
  const id = reader.u16();
  const flags = reader.u16();
  const counts = [reader.u16(), reader.u16(), reader.u16(), reader.u16()];
  const [qd, an, ns, ar] = counts as [number, number, number, number];
  const many = <T>(count: number, read: () => T): T[] =>
    Array.from({ length: count }, read);
  return {
    id,
    isResponse: (flags & FLAG_RESPONSE) !== 0,
    questions: many(qd, () => readQuestion(reader)),
    answers: many(an, () => readRecord(reader)),
    authorities: many(ns, () => readRecord(reader)),
    additionals: many(ar, () => readRecord(reader)),
  };
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".").filter((part) => part !== "")) {
    const bytes = Buffer.from(label, "latin1");
    if (bytes.length > 63) throw new DnsPacketError(`Label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function encodeRecord(record: ResourceRecord): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(CLASS_IN | (record.cacheFlush ? CACHE_FLUSH : 0), 2);
  fixed.writeUInt32BE(record.ttl, 4);
  fixed.writeUInt16BE(record.data.length, 8);
  return Buffer.concat([encodeName(record.name), fixed, record.data]);
}

export function encodePacket(packet: {
  readonly id?: number;
  readonly isResponse: boolean;
  readonly questions?: readonly Question[];
  readonly answers?: readonly ResourceRecord[];
  readonly authorities?: readonly ResourceRecord[];
}): Buffer {
  const questions = packet.questions ?? [];
  const answers = packet.answers ?? [];
  const authorities = packet.authorities ?? [];
  const header = Buffer.concat([
    u16(packet.id ?? 0),
    u16(packet.isResponse ? FLAG_RESPONSE | FLAG_AUTHORITATIVE : 0),
    u16(questions.length),
    u16(answers.length),
    u16(authorities.length),
    u16(0),
  ]);
  return Buffer.concat([
    header,
    ...questions.map((question) =>
      Buffer.concat([
        encodeName(question.name),
        u16(question.type),
        u16(CLASS_IN | (question.unicastResponse ? UNICAST_RESPONSE : 0)),
      ]),
    ),
    ...answers.map(encodeRecord),
    ...authorities.map(encodeRecord),
  ]);
}

/** An A record for `name`: a unique record, so it carries the cache-flush bit. */
export function aRecord(
  name: string,
  address: string,
  ttl: number,
): ResourceRecord {
  if (!isIPv4(address)) throw new DnsPacketError(`Not IPv4: ${address}`);
  return { name, type: TYPE.A, cacheFlush: true, ttl, data: ipBytes(address) };
}

/** The dotted IPv4 address an A record carries, or null for any other. */
export function aAddress(record: ResourceRecord): string | null {
  return record.type === TYPE.A && record.data.length === 4
    ? [...record.data].join(".")
    : null;
}
