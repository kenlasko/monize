import { BlockList, isIPv4 } from "net";

import {
  aAddress,
  aRecord,
  decodePacket,
  encodePacket,
  Packet,
  Question,
  ResourceRecord,
  TYPE,
} from "./dns-packet";
import { localName } from "./names";

/**
 * The app's own mDNS name (docs/future-plans/desktop-lan-access.md, L7 and
 * section 6): it probes for a label, claims the first one nobody on the
 * network holds, and from then on answers A queries for it.
 *
 * - Probing follows RFC 6762 section 8: three queries 250 ms apart, the
 *   proposed record in the authority section, after a random wait of up to
 *   250 ms. An answer for the name from another device, or a simultaneous
 *   probe that wins the tie-break, moves on to the next label.
 * - Each answer carries the address of this PC's adapter on the asking
 *   device's subnet, and a query from a subnet the PC has no adapter on gets
 *   none. That is what keeps a phone from being handed a WSL, Hyper-V or VPN
 *   address it cannot reach.
 * - IPv4 only: an AAAA query gets no answer, and devices fall back to IPv4.
 * - Closing sends a goodbye (TTL 0), so devices forget the name at once.
 *
 * The network is behind `MdnsTransport`; `udpTransport` is the real one.
 */

export const MDNS_PORT = 5353;
export const MDNS_GROUP = "224.0.0.251";
export const RECORD_TTL_SECONDS = 120;

export interface Endpoint {
  readonly address: string;
  readonly port: number;
}

export interface MdnsTransport {
  /** `via`: the local address whose adapter a multicast leaves from. */
  send(packet: Buffer, to: Endpoint, via: string | null): Promise<void>;
  onMessage(handler: (packet: Buffer, from: Endpoint) => void): void;
  /** Join the group on each of these local addresses (again is harmless). */
  join(addresses: readonly string[]): void;
  close(): Promise<void>;
}

export interface AdapterAddress {
  readonly address: string;
  readonly cidr: string;
}

export interface MdnsTiming {
  readonly probeIntervalMs: number;
  readonly announceIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export const DEFAULT_TIMING: MdnsTiming = {
  probeIntervalMs: 250,
  announceIntervalMs: 1000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export interface MdnsOptions {
  readonly transport: MdnsTransport;
  /** Labels in the order to try (`names.ts`, `mdnsCandidates`). */
  readonly candidates: readonly string[];
  /** This PC's IPv4 adapter addresses, read whenever they are needed. */
  readonly addresses: () => readonly AdapterAddress[];
  readonly log: (message: string) => void;
  readonly timing?: MdnsTiming;
}

export interface MdnsResponder {
  /** The label claimed, without `.local`. */
  readonly label: string;
  /** Join new adapters and announce again: call when the addresses change. */
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export class MdnsError extends Error {
  readonly code = "MDNS_NO_NAME";

  constructor(message: string) {
    super(message);
    this.name = "MdnsError";
  }
}

const GROUP: Endpoint = { address: MDNS_GROUP, port: MDNS_PORT };

function ipv4(addresses: readonly AdapterAddress[]): AdapterAddress[] {
  return addresses.filter((entry) => isIPv4(entry.address));
}

/** The adapter address on the same subnet as `remote`, or null. */
export function addressFacing(
  remote: string,
  addresses: readonly AdapterAddress[],
): string | null {
  if (!isIPv4(remote)) return null;
  for (const entry of ipv4(addresses)) {
    const [network, prefix] = entry.cidr.split("/");
    const subnet = new BlockList();
    subnet.addSubnet(network as string, Number(prefix), "ipv4");
    if (subnet.check(remote, "ipv4")) return entry.address;
  }
  return null;
}

function asksFor(question: Question, name: string): boolean {
  return (
    question.name === name &&
    (question.type === TYPE.A || question.type === TYPE.ANY)
  );
}

export async function startMdns(options: MdnsOptions): Promise<MdnsResponder> {
  const timing = options.timing ?? DEFAULT_TIMING;
  const { transport } = options;
  let probing: { name: string; conflict: boolean } | null = null;
  let claimed: string | null = null;

  const own = (): Set<string> =>
    new Set(ipv4(options.addresses()).map((entry) => entry.address));

  /** Another device's record for `name`: anything but our own A records. */
  function foreign(records: readonly ResourceRecord[], name: string): boolean {
    const mine = own();
    return records.some((record) => {
      if (record.name !== name) return false;
      const address = aAddress(record);
      return address === null || !mine.has(address);
    });
  }

  /** Ties go to the lexicographically later data (RFC 6762 section 8.2). */
  function losesTieBreak(packet: Packet, name: string): boolean {
    const theirs = packet.authorities.find((record) => record.name === name);
    if (theirs === undefined || !foreign([theirs], name)) return false;
    const ours = ipv4(options.addresses())[0];
    if (ours === undefined) return true;
    return Buffer.compare(theirs.data, aRecord(name, ours.address, 0).data) > 0;
  }

  async function answer(packet: Packet, from: Endpoint): Promise<void> {
    if (claimed === null) return;
    const name = localName(claimed);
    const questions = packet.questions.filter((q) => asksFor(q, name));
    if (questions.length === 0) return;
    const address = addressFacing(from.address, options.addresses());
    if (address === null) return;
    const record = aRecord(name, address, RECORD_TTL_SECONDS);
    if (from.port !== MDNS_PORT) {
      // A legacy resolver (section 6.7): unicast, its id, its question.
      await transport.send(
        encodePacket({
          id: packet.id,
          isResponse: true,
          questions,
          answers: [{ ...record, cacheFlush: false, ttl: 10 }],
        }),
        from,
        null,
      );
      return;
    }
    const unicast = questions.every((q) => q.unicastResponse);
    await transport.send(
      encodePacket({ isResponse: true, answers: [record] }),
      unicast ? from : GROUP,
      unicast ? null : address,
    );
  }

  transport.onMessage((buffer, from) => {
    let packet: Packet;
    try {
      packet = decodePacket(buffer);
    } catch {
      return;
    }
    if (probing !== null) {
      const name = probing.name;
      if (
        (packet.isResponse &&
          foreign([...packet.answers, ...packet.additionals], name)) ||
        (!packet.isResponse && losesTieBreak(packet, name))
      ) {
        probing.conflict = true;
      }
      return;
    }
    if (claimed !== null && packet.isResponse) {
      const name = localName(claimed);
      if (foreign(packet.answers, name)) {
        options.log(
          `mDNS: another device on the network also answers for ${name}.`,
        );
      }
      return;
    }
    void answer(packet, from).catch(() => undefined);
  });

  async function sendEach(
    build: (adapter: AdapterAddress) => Buffer,
  ): Promise<void> {
    for (const adapter of ipv4(options.addresses())) {
      await transport
        .send(build(adapter), GROUP, adapter.address)
        .catch(() => undefined);
    }
  }

  async function probe(label: string): Promise<boolean> {
    const name = localName(label);
    probing = { name, conflict: false };
    await timing.sleep(Math.floor(timing.random() * timing.probeIntervalMs));
    for (let i = 0; i < 3 && !probing.conflict; i++) {
      await sendEach((adapter) =>
        encodePacket({
          isResponse: false,
          questions: [{ name, type: TYPE.ANY, unicastResponse: true }],
          authorities: [aRecord(name, adapter.address, RECORD_TTL_SECONDS)],
        }),
      );
      await timing.sleep(timing.probeIntervalMs);
    }
    const won = !probing.conflict;
    probing = null;
    return won;
  }

  async function announce(label: string, ttl: number): Promise<void> {
    const name = localName(label);
    await sendEach((adapter) =>
      encodePacket({
        isResponse: true,
        answers: [aRecord(name, adapter.address, ttl)],
      }),
    );
  }

  transport.join(ipv4(options.addresses()).map((entry) => entry.address));
  for (const label of options.candidates) {
    if (await probe(label)) {
      claimed = label;
      break;
    }
    options.log(`mDNS: ${localName(label)} is taken on this network.`);
  }
  if (claimed === null) {
    await transport.close();
    throw new MdnsError(
      "Every name Monize tries on this network is already taken.",
    );
  }
  const label = claimed;
  await announce(label, RECORD_TTL_SECONDS);
  void timing
    .sleep(timing.announceIntervalMs)
    .then(() =>
      claimed === null ? undefined : announce(label, RECORD_TTL_SECONDS),
    );

  return {
    label,
    async refresh() {
      transport.join(ipv4(options.addresses()).map((entry) => entry.address));
      if (claimed !== null) await announce(label, RECORD_TTL_SECONDS);
    },
    async close() {
      if (claimed === null) return;
      claimed = null;
      await announce(label, 0);
      await transport.close();
    },
  };
}
